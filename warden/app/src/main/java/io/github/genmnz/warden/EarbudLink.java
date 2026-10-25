package io.github.genmnz.warden;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * One earbud connection. Two ways to read it:
 *  - Passive: a short BLE scan reads battery straight from the advertisement
 *    (Apple-style and Xiaomi-style), no pairing, works with the case open.
 *  - Active: for JieLi earbuds (GATT service AE00), connect, run the auth
 *    handshake, then read live battery and change game mode / ANC.
 *
 * All Bluetooth callbacks are marshalled onto the main thread, so the listener
 * never has to worry about threading.
 */
@SuppressLint("MissingPermission") // BLUETOOTH_CONNECT/SCAN are requested by EarbudsActivity before anything here runs
final class EarbudLink {
    private static UUID uuid(String s) { return UUID.fromString(s); }

    static final UUID JL_SERVICE = uuid("0000ae00-0000-1000-8000-00805f9b34fb");
    private static final UUID JL_WRITE = uuid("0000ae01-0000-1000-8000-00805f9b34fb");
    private static final UUID JL_NOTIFY = uuid("0000ae02-0000-1000-8000-00805f9b34fb");
    private static final UUID CCCD = uuid("00002902-0000-1000-8000-00805f9b34fb");
    private static final UUID APPLE_FP = uuid("0000fd2d-0000-1000-8000-00805f9b34fb"); // Xiaomi Fast Connect service data
    private static final int APPLE_COMPANY = 0x004C, XIAOMI_COMPANY = 0x038F;

    interface Listener {
        void status(String text);
        void battery(Earbuds.Battery b);
        void info(Earbuds.JieliInfo info);
        void log(String line);
    }

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BluetoothAdapter adapter;
    private Listener listener;

    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic writeChar;
    private final Earbuds.RcspReader reader = new Earbuds.RcspReader();
    private final ArrayDeque<byte[]> writeQueue = new ArrayDeque<>();
    private boolean writing, authed;
    private int sn = 1;
    private byte[] voiceModeRecord;
    private String targetMac;

    private BluetoothLeScanner scanner;
    private ScanCallback scanCb;

    EarbudLink(Context c) {
        ctx = c;
        BluetoothAdapter a = null;
        try {
            a = ((android.bluetooth.BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE)).getAdapter();
        } catch (RuntimeException ignored) {
        }
        adapter = a;
    }

    void setListener(Listener l) { listener = l; }

    boolean ready() { return adapter != null && adapter.isEnabled(); }

    // ----------------------------------------------------- bonded devices

    /** Paired audio devices, newest-looking first. {name, mac}. */
    List<String[]> pairedAudio() {
        List<String[]> out = new ArrayList<>();
        if (adapter == null) return out;
        try {
            for (BluetoothDevice d : adapter.getBondedDevices()) {
                int major = d.getBluetoothClass() == null ? 0 : d.getBluetoothClass().getMajorDeviceClass();
                if (major == android.bluetooth.BluetoothClass.Device.Major.AUDIO_VIDEO || major == 0) {
                    String name = d.getName();
                    out.add(new String[]{name == null ? d.getAddress() : name, d.getAddress()});
                }
            }
        } catch (RuntimeException ignored) {
        }
        return out;
    }

    // ----------------------------------------------------- passive scan (battery from advertisement)

    void startScan() {
        if (!ready() || scanner != null) return;
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return;
        scanCb = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult r) { onAdvertisement(r); }
            @Override public void onBatchScanResults(List<ScanResult> rs) { for (ScanResult r : rs) onAdvertisement(r); }
            @Override public void onScanFailed(int code) { post(() -> { if (listener != null) listener.status("Scan failed (" + code + ")"); }); }
        };
        try {
            scanner.startScan(scanCb);
        } catch (RuntimeException e) {
            scanner = null;
        }
    }

    void stopScan() {
        if (scanner != null && scanCb != null) {
            try { scanner.stopScan(scanCb); } catch (RuntimeException ignored) { }
        }
        scanner = null;
        scanCb = null;
    }

    private void onAdvertisement(ScanResult r) {
        ScanRecord rec = r.getScanRecord();
        if (rec == null) return;
        Earbuds.Battery b = null;
        byte[] apple = rec.getManufacturerSpecificData(APPLE_COMPANY);
        if (apple != null) b = Earbuds.apple(apple);
        if (b == null) {
            byte[] xi = rec.getManufacturerSpecificData(XIAOMI_COMPANY);
            if (xi != null) b = Earbuds.xiaomi(xi);
        }
        if (b == null) {
            byte[] fd2d = rec.getServiceData(new android.os.ParcelUuid(APPLE_FP));
            if (fd2d != null) b = Earbuds.xiaomiFd2d(fd2d);
        }
        if (b == null || !b.any()) return;
        String name = null;
        try { name = r.getDevice().getName(); } catch (RuntimeException ignored) { }
        if (b.model.isEmpty()) b.model = name == null ? r.getDevice().getAddress() : name;
        final Earbuds.Battery fb = b;
        post(() -> { if (listener != null) listener.battery(fb); });
    }

    // ----------------------------------------------------- active JieLi connection

    void connect(String mac) {
        disconnect();
        targetMac = mac;
        BluetoothDevice dev;
        try {
            dev = adapter.getRemoteDevice(mac);
        } catch (RuntimeException e) {
            status("Bad address");
            return;
        }
        status("Connecting…");
        authed = false;
        reader.feed(new byte[0]);
        gatt = dev.connectGatt(ctx, false, callback, BluetoothDevice.TRANSPORT_LE);
    }

    void disconnect() {
        authed = false;
        writeQueue.clear();
        writing = false;
        if (gatt != null) {
            try { gatt.disconnect(); gatt.close(); } catch (RuntimeException ignored) { }
            gatt = null;
        }
    }

    boolean isConnected() { return gatt != null; }

    boolean isAuthed() { return authed; }

    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int s, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                status("Discovering services…");
                try { g.requestMtu(517); } catch (RuntimeException ignored) { }
                main.postDelayed(() -> { try { g.discoverServices(); } catch (RuntimeException ignored) { } }, 300);
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                authed = false;
                status("Disconnected");
            }
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int s) { }

        @Override public void onServicesDiscovered(BluetoothGatt g, int s) {
            List<String> clues = new ArrayList<>();
            BluetoothGattService jl = null;
            for (BluetoothGattService svc : g.getServices()) {
                String name = Earbuds.service(svc.getUuid().toString());
                if (name != null) clues.add(name);
                if (JL_SERVICE.equals(svc.getUuid())) jl = svc;
            }
            String verdict = Earbuds.chipVerdict(clues);
            log("Services: " + (clues.isEmpty() ? "standard audio only" : String.join(", ", clues)));
            if (jl == null) {
                status(verdict != null ? verdict + " earbuds — no JieLi control service, battery only via scan"
                        : "No control service found. Battery may still show from the scan above.");
                return;
            }
            writeChar = jl.getCharacteristic(JL_WRITE);
            BluetoothGattCharacteristic notify = jl.getCharacteristic(JL_NOTIFY);
            if (writeChar == null || notify == null) { status("JieLi service incomplete"); return; }
            g.setCharacteristicNotification(notify, true);
            BluetoothGattDescriptor cccd = notify.getDescriptor(CCCD);
            if (cccd != null) {
                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                g.writeDescriptor(cccd);
            }
            status("JieLi earbuds — authenticating…");
            if (cccd == null) startHandshake(); // no CCCD: send now and hope notifications are on
        }

        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int s) {
            if (CCCD.equals(d.getUuid())) startHandshake();
        }

        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic ch, int s) {
            writing = false;
            pump();
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value) {
            handleNotify(value);
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
            handleNotify(ch.getValue());
        }
    };

    /** Begin the JieLi 6-step handshake: 0x00 + 16 random bytes, raw on AE01. */
    private void startHandshake() {
        byte[] rnd = new byte[16];
        new java.security.SecureRandom().nextBytes(rnd);
        enqueue(Earbuds.concat(new byte[]{0x00}, rnd));
    }

    private void handleNotify(byte[] value) {
        if (value == null || value.length == 0) return;
        // During auth the device replies raw (not RCSP-framed).
        if (!authed) {
            if (value[0] == 0x01 && value.length == 17) {
                // step 2: device encrypted our random. We skip verifying it (we have no device key)
                // and move the handshake forward, which is what real devices accept.
                enqueue(Earbuds.AUTH_PASS);
                return;
            }
            if (value[0] == 0x00 && value.length == 17) {
                // step 4: device challenge -> step 5: our encryption
                byte[] enc = JlAuth.encrypt(java.util.Arrays.copyOfRange(value, 1, 17));
                enqueue(Earbuds.concat(new byte[]{0x01}, enc));
                return;
            }
            if (value.length >= 5 && value[0] == 0x02 && value[1] == 'p') {
                authed = true;
                status("Connected · reading…");
                enqueue(Earbuds.getAdvInfo(sn++));
                enqueue(Earbuds.getVoiceMode(sn++));
                return;
            }
        }
        for (Earbuds.Frame f : reader.feed(value)) onFrame(f);
    }

    private void onFrame(Earbuds.Frame f) {
        switch (f.op) {
            case Earbuds.RCSP_ADV_PUSH: {
                Earbuds.Battery b = Earbuds.jieliPush(f.params);
                if (b != null) post(() -> { if (listener != null) listener.battery(b); });
                break;
            }
            case Earbuds.RCSP_GET_ADV: {
                // Only the GET reply carries the full settings; a SET reply is status-only,
                // so parsing that would wipe the controls. We re-GET after every SET instead.
                Earbuds.JieliInfo info = Earbuds.parseAdvInfo(f.params);
                post(() -> {
                    if (listener == null) return;
                    if (info.battery != null) listener.battery(info.battery);
                    listener.info(info);
                });
                break;
            }
            case Earbuds.RCSP_GET_SYS_INFO:
            case Earbuds.RCSP_SET_SYS_INFO: {
                byte[] rec = Earbuds.voiceModeRecord(f.params);
                if (rec != null) voiceModeRecord = rec;
                break;
            }
            case Earbuds.RCSP_DEV_REQUEST:
                // the earbuds ask us to acknowledge (e.g. a bud went back in the case)
                if (f.wantsReply()) enqueue(Earbuds.rcspReply(Earbuds.RCSP_DEV_REQUEST, f.sn));
                break;
            default:
                break;
        }
    }

    // ----------------------------------------------------- commands

    void refresh() {
        if (authed) { enqueue(Earbuds.getAdvInfo(sn++)); enqueue(Earbuds.getVoiceMode(sn++)); }
    }

    void setGameMode(boolean on) {
        if (!authed) return;
        log("Set work mode → " + (on ? "gaming" : "normal"));
        enqueue(Earbuds.setAdv(sn++, Earbuds.ADV_WORK_MODE, new byte[]{(byte) (on ? 2 : 1)}));
        enqueue(Earbuds.getAdvInfo(sn++));
    }

    void setMicChannel(int channel) {
        if (!authed) return;
        enqueue(Earbuds.setAdv(sn++, Earbuds.ADV_MIC, new byte[]{(byte) channel}));
        enqueue(Earbuds.getAdvInfo(sn++));
    }

    /** 0 off, 1 noise-cancel, 2 transparency — needs a voice-mode record read first. */
    void setAnc(int mode) {
        if (!authed) return;
        if (voiceModeRecord == null) { log("ANC not reported by this firmware"); return; }
        log("Set ANC → " + mode);
        enqueue(Earbuds.setVoiceMode(sn++, voiceModeRecord, mode));
        enqueue(Earbuds.getVoiceMode(sn++));
    }

    boolean ancAvailable() { return voiceModeRecord != null; }

    // ----------------------------------------------------- write queue (one GATT write at a time)

    private void enqueue(byte[] data) {
        writeQueue.add(data);
        pump();
    }

    private int writeToken;

    private void pump() {
        if (writing || gatt == null || writeChar == null) return;
        byte[] data = writeQueue.poll();
        if (data == null) return;
        writing = true;
        final int token = ++writeToken;
        try {
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                gatt.writeCharacteristic(writeChar, data, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            } else {
                writeChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                writeChar.setValue(data);
                gatt.writeCharacteristic(writeChar);
            }
        } catch (RuntimeException e) {
            writing = false;
        }
        // NO_RESPONSE writes don't always call onCharacteristicWrite; move on if this exact
        // write is still pending after a short gap. The token stops a stale timer from
        // advancing the queue once a real callback (or a newer write) has taken over.
        main.postDelayed(() -> { if (writing && writeToken == token) { writing = false; pump(); } }, 140);
    }

    private void status(String s) { post(() -> { if (listener != null) listener.status(s); }); }

    private void log(String s) { post(() -> { if (listener != null) listener.log(s); }); }

    private void post(Runnable r) { main.post(r); }
}
