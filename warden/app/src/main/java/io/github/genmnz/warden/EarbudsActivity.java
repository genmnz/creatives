package io.github.genmnz.warden;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;
import java.util.Locale;

/**
 * "My earbuds". Recognises any pair of buds, reads battery by whatever means works,
 * shows diagnostics, remembers devices, and — through the Lab — lets you probe an
 * unknown chip and teach Melad where its battery lives. No layout files, no libraries.
 */
public final class EarbudsActivity extends Activity implements EarbudLink.Listener {
    private static final int REQ_BT = 7;

    private EarbudLink link;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private LinearLayout root, devices, controls, history;
    private TextView statusLine, batteryLine, chipLine, diagLine, devInfoLine, logView;
    private final StringBuilder logBuf = new StringBuilder();
    private Earbuds.JieliInfo info;
    private String connectedMac, connectedName;
    private List<String[]> lastInspector;
    private String lastRawChar = "", lastRawValue = "";

    private static final String[] WORK_MODE = {"", "Normal", "Gaming"};
    private static final String[] MIC = {"", "Automatic", "Always left", "Always right"};
    private static final String[] ANC = {"Off", "Noise cancelling", "Transparency"};

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setTitle("My earbuds");
        link = new EarbudLink(this);
        link.setListener(this);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        root.setPadding(pad, pad, pad, dp(48));
        ScrollView sv = new ScrollView(this);
        sv.setFitsSystemWindows(true);
        sv.addView(root);
        setContentView(sv);
        build();
    }

    @Override protected void onResume() {
        super.onResume();
        if (ensurePerms()) start();
    }

    @Override protected void onPause() { link.stopScan(); super.onPause(); }

    @Override protected void onDestroy() { link.disconnect(); link.stopScan(); super.onDestroy(); }

    private void build() {
        root.removeAllViews();
        root.addView(small("Works with any earbuds — recognised or not. Battery shows from a quick scan (case open); "
                + "connect for live battery, diagnostics and controls. Unknown chip? Open the Lab to read it and teach a rule."));

        if (!link.ready()) {
            root.addView(big("Bluetooth is off", 18));
            root.addView(small("Turn Bluetooth on, then come back."));
            return;
        }

        statusLine = card("Scanning for earbuds nearby…");
        root.addView(statusLine);
        batteryLine = big("—", 30);
        batteryLine.setPadding(0, dp(8), 0, 0);
        root.addView(batteryLine);
        chipLine = small("");
        root.addView(chipLine);
        diagLine = small("");
        root.addView(diagLine);
        devInfoLine = small("");
        root.addView(devInfoLine);

        controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.VERTICAL);
        root.addView(controls);

        header("Paired earbuds");
        root.addView(small("Tap to connect. JieLi buds get full control; any bud shows what it can."));
        devices = new LinearLayout(this);
        devices.setOrientation(LinearLayout.VERTICAL);
        root.addView(devices);
        row(button("Refresh", v -> { listDevices(); listHistory(); }),
                button("Inspector", v -> showInspector()));
        row(button("Lab (advanced)", v -> openLab()),
                button("Rename / forget", v -> renameOrForget()));

        header("History");
        history = new LinearLayout(this);
        history.setOrientation(LinearLayout.VERTICAL);
        root.addView(history);

        header("Activity");
        logView = small("");
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setTextSize(11);
        root.addView(logView);

        listDevices();
        listHistory();
    }

    // ------------------------------------------------------------------ permissions

    private boolean ensurePerms() {
        if (Build.VERSION.SDK_INT < 31) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, REQ_BT);
                return false;
            }
            return true;
        }
        boolean scan = checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
        boolean conn = checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        if (scan && conn) return true;
        requestPermissions(new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT}, REQ_BT);
        return false;
    }

    @Override public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        boolean ok = res.length > 0;
        for (int r : res) ok &= r == PackageManager.PERMISSION_GRANTED;
        if (ok) start();
        else toast("Bluetooth permission is needed to see earbuds");
    }

    private void start() {
        if (statusLine == null) build();
        link.startScan();
        listDevices();
        listHistory();
    }

    // ------------------------------------------------------------------ device + history lists

    private void listDevices() {
        if (devices == null) return;
        devices.removeAllViews();
        List<String[]> paired = link.pairedAudio();
        if (paired.isEmpty()) {
            devices.addView(small("No paired audio devices. Pair your earbuds in Settings → Bluetooth first."));
            return;
        }
        for (String[] d : paired) {
            final String name = d[0], mac = d[1];
            Button b = button(name + "\n" + mac, v -> connect(mac, name));
            devices.addView(b);
        }
    }

    private void listHistory() {
        if (history == null) return;
        history.removeAllViews();
        List<Earbuds.BudRecord> all = History.all(this);
        if (all.isEmpty()) { history.addView(small("Devices you connect to will be remembered here.")); return; }
        for (Earbuds.BudRecord r : all) {
            StringBuilder sb = new StringBuilder();
            sb.append(r.name.isEmpty() ? r.mac : r.name);
            if (!r.chip.isEmpty()) sb.append("  ·  ").append(r.chip);
            sb.append('\n');
            if (!r.lastBattery.isEmpty() && !r.lastBattery.equals("unknown")) sb.append(r.lastBattery).append("   ");
            if (r.connectedMs > 0) sb.append("connected ").append(Earbuds.uptime(r.connectedMs)).append(" total");
            if (r.rule != null && r.rule.usable()) sb.append("   · taught");
            TextView t = small(sb.toString());
            t.setPadding(dp(4), dp(4), dp(4), dp(4));
            final String mac = r.mac, name = r.name.isEmpty() ? r.mac : r.name;
            t.setOnClickListener(v -> connect(mac, name));
            history.addView(t);
        }
    }

    private void connect(String mac, String name) {
        connectedMac = mac;
        connectedName = name;
        info = null;
        rebuildControls();
        log("Connecting to " + name);
        link.connect(mac);
    }

    private void rebuildControls() {
        if (controls == null) return;
        controls.removeAllViews();
        if (info == null || !link.isAuthed()) return;
        TextView h = big("Controls", 18);
        h.setPadding(0, dp(24), 0, dp(6));
        controls.addView(h);
        if (info.workMode > 0) {
            controls.addView(label("Game mode (low latency)"));
            controls.addView(segmented(new String[]{"Normal", "Gaming"}, info.workMode == 2 ? 1 : 0, i -> link.setGameMode(i == 1)));
        }
        if (link.ancAvailable()) {
            controls.addView(label("Noise control"));
            controls.addView(segmented(ANC, -1, link::setAnc));
        }
        if (info.micChannel > 0) {
            controls.addView(label("Microphone: " + name(MIC, info.micChannel)));
            controls.addView(segmented(new String[]{"Auto", "Left", "Right"}, info.micChannel - 1, i -> link.setMicChannel(i + 1)));
        }
        if (info.workMode <= 0 && !link.ancAvailable() && info.micChannel <= 0)
            controls.addView(small("This firmware reports battery but no adjustable modes."));
        controls.addView(button("Disconnect", v -> { link.disconnect(); info = null; rebuildControls(); listHistory(); }));
    }

    // ------------------------------------------------------------------ inspector + rename

    private void showInspector() {
        if (lastInspector == null || lastInspector.isEmpty()) { toast("Connect to a device first"); return; }
        StringBuilder sb = new StringBuilder();
        String lastSvc = "";
        for (String[] r : lastInspector) {
            if (!r[0].equals(lastSvc)) { sb.append(sb.length() > 0 ? "\n" : "").append(r[0]).append('\n'); lastSvc = r[0]; }
            sb.append("   ").append(r[1]).append("  [").append(r[2]).append("]\n");
        }
        TextView t = new TextView(this);
        t.setText(sb.toString());
        t.setTypeface(Typeface.MONOSPACE);
        t.setTextSize(11);
        t.setPadding(dp(16), dp(8), dp(16), dp(8));
        ScrollView sv = new ScrollView(this);
        sv.addView(t);
        new AlertDialog.Builder(this).setTitle("What this device exposes").setView(sv)
                .setPositiveButton("Close", null).show();
    }

    private void renameOrForget() {
        if (connectedMac == null) { toast("Connect to a device first"); return; }
        EditText in = new EditText(this);
        in.setSingleLine();
        in.setText(connectedName);
        new AlertDialog.Builder(this).setTitle("Rename")
                .setMessage("A new name for " + connectedMac + ". On Android 12+ this renames it everywhere; otherwise just inside Melad.")
                .setView(in)
                .setPositiveButton("Rename", (d, w) -> {
                    String n = in.getText().toString().trim();
                    if (n.isEmpty()) return;
                    boolean sys = link.rename(connectedMac, n);
                    connectedName = n;
                    toast(sys ? "Renamed" : "Renamed inside Melad");
                    listHistory();
                })
                .setNeutralButton("Forget device", (d, w) -> { History.forget(this, connectedMac); listHistory(); toast("Forgotten"); })
                .setNegativeButton("Cancel", null).show();
    }

    // ------------------------------------------------------------------ the Lab

    private void openLab() {
        List<String[]> chars = link.labChars();
        if (chars.isEmpty()) { toast("Connect to a device first"); return; }
        String[] labels = new String[chars.size()];
        for (int i = 0; i < labels.length; i++) labels[i] = chars.get(i)[0] + "  [" + chars.get(i)[2] + "]";
        new AlertDialog.Builder(this).setTitle("Lab — pick a characteristic")
                .setItems(labels, (d, which) -> labActions(chars.get(which)))
                .setNeutralButton("Teach battery rule", (d, w) -> teachRuleDialog())
                .setNegativeButton("Close", null).show();
    }

    private void labActions(String[] ch) {
        final String uuid = ch[1];
        new AlertDialog.Builder(this).setTitle(ch[0])
                .setMessage("UUID " + uuid + "\nProperties " + ch[2]
                        + "\n\nWatch to see live bytes in Activity, Read for a one-off, or Send bytes to it.")
                .setItems(new String[]{"Watch (notify)", "Read once", "Send hex…"}, (d, which) -> {
                    if (which == 0) link.labSubscribe(uuid);
                    else if (which == 1) link.labRead(uuid);
                    else sendHexDialog(uuid);
                })
                .setNegativeButton("Back", (d, w) -> openLab()).show();
    }

    private void sendHexDialog(String uuid) {
        EditText in = new EditText(this);
        in.setHint("e.g. 05 5A 02 00 08 1E");
        in.setSingleLine();
        new AlertDialog.Builder(this).setTitle("Send bytes")
                .setMessage("Hex to write to " + uuid + ". Safe to experiment — these are the same kind of commands the official app sends.")
                .setView(in)
                .setPositiveButton("Send", (d, w) -> {
                    byte[] data = Earbuds.unhex(in.getText().toString());
                    if (data.length == 0) { toast("Enter some hex"); return; }
                    link.labWrite(uuid, data);
                })
                .setNegativeButton("Cancel", null).show();
    }

    /** Teach Melad which bytes of the last-watched value are the battery levels. */
    private void teachRuleDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), dp(8), dp(16), 0);
        box.addView(small(lastRawValue.isEmpty()
                ? "Tip: first Watch a characteristic and look at its bytes in Activity. Then set the byte positions (0 = first byte)."
                : "Last value on " + shortOf(lastRawChar) + ":\n" + lastRawValue + "\nByte positions start at 0."));
        final EditText left = field(box, "Left battery at byte # (blank = none)");
        final EditText right = field(box, "Right battery at byte #");
        final EditText bud = field(box, "Case battery at byte #");
        final EditText single = field(box, "Single/combined battery at byte #");
        final EditText mask = field(box, "Mask (hex, default 7F)");
        mask.setText("7F");
        final CheckBox charge = new CheckBox(this);
        charge.setText("Top bit (0x80) means charging");
        charge.setChecked(true);
        box.addView(charge);
        ScrollView sv = new ScrollView(this);
        sv.addView(box);
        new AlertDialog.Builder(this).setTitle("Teach battery rule").setView(sv)
                .setPositiveButton("Save", (d, w) -> {
                    if (lastRawChar.isEmpty()) { toast("Watch a characteristic first"); return; }
                    Earbuds.CustomRule r = new Earbuds.CustomRule();
                    r.chr = lastRawChar;
                    r.left = intOr(left, -1); r.right = intOr(right, -1); r.box = intOr(bud, -1); r.single = intOr(single, -1);
                    try { r.mask = Integer.parseInt(mask.getText().toString().trim(), 16); } catch (NumberFormatException e) { r.mask = 0x7F; }
                    r.highBitCharge = charge.isChecked();
                    if (!r.usable()) { toast("Set at least one byte position"); return; }
                    link.teachRule(r);
                    toast("Saved. Battery will show from your rule.");
                })
                .setNegativeButton("Cancel", null).show();
    }

    // ------------------------------------------------------------------ listener callbacks (main thread)

    @Override public void status(String text) { if (statusLine != null) statusLine.setText(text); }

    @Override public void battery(Earbuds.Battery b) {
        if (batteryLine == null) return;
        batteryLine.setText(b.toString());
        StringBuilder sb = new StringBuilder();
        if (!b.model.isEmpty()) sb.append(b.model);
        if (!b.source.isEmpty()) sb.append(sb.length() > 0 ? "  ·  " : "").append(b.source);
        chipLine.setText(sb);
    }

    @Override public void controls(Earbuds.JieliInfo i) {
        info = i;
        StringBuilder sb = new StringBuilder();
        if (i.name != null) sb.append(i.name);
        if (i.vid >= 0) sb.append(sb.length() > 0 ? "  ·  " : "").append(String.format(Locale.ROOT, "VID %04X PID %04X", i.vid, i.pid));
        if (sb.length() > 0) chipLine.setText(sb);
        rebuildControls();
    }

    @Override public void deviceInfo(String maker, String model, String firmware) {
        StringBuilder sb = new StringBuilder();
        if (maker != null && !maker.isEmpty()) sb.append(maker);
        if (model != null && !model.isEmpty()) sb.append(sb.length() > 0 ? " " : "").append(model);
        if (firmware != null && !firmware.isEmpty()) sb.append("  ·  fw ").append(firmware);
        if (devInfoLine != null && sb.length() > 0) devInfoLine.setText(sb);
    }

    @Override public void inspector(List<String[]> rows) { lastInspector = rows; }

    @Override public void diagnostics(int latencyMs, int rssi, long uptimeMs) {
        if (diagLine == null) return;
        StringBuilder sb = new StringBuilder();
        if (rssi != 0) sb.append("Signal ").append(rssi).append(" dBm");
        if (latencyMs >= 0) sb.append(sb.length() > 0 ? "  ·  " : "").append("response ").append(latencyMs).append(" ms");
        if (uptimeMs > 0) sb.append(sb.length() > 0 ? "  ·  " : "").append("connected ").append(Earbuds.uptime(uptimeMs));
        diagLine.setText(sb);
    }

    @Override public void raw(String charUuid, byte[] value) {
        lastRawChar = charUuid;
        lastRawValue = Earbuds.hex(value);
        log(shortOf(charUuid) + " → " + lastRawValue);
    }

    @Override public void log(String line) {
        logBuf.insert(0, line + "\n");
        if (logBuf.length() > 3000) logBuf.setLength(3000);
        if (logView != null) logView.setText(logBuf);
    }

    // ------------------------------------------------------------------ view helpers

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private TextView big(String s, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView small(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(13);
        t.setAlpha(0.75f);
        t.setPadding(0, dp(2), 0, dp(6));
        return t;
    }

    private TextView label(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(14);
        t.setPadding(0, dp(10), 0, dp(4));
        return t;
    }

    private TextView card(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(14);
        t.setPadding(dp(14), dp(12), dp(14), dp(12));
        t.setBackgroundColor(0x22808080);
        return t;
    }

    private void header(String s) {
        TextView t = big(s, 18);
        t.setPadding(0, dp(24), 0, dp(6));
        root.addView(t);
    }

    private Button button(String s, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        return b;
    }

    private void row(View a, View b) {
        LinearLayout l = new LinearLayout(this);
        l.addView(a, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        l.addView(b, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(l);
    }

    private EditText field(LinearLayout box, String hint) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setSingleLine();
        e.setInputType(InputType.TYPE_CLASS_TEXT);
        box.addView(e);
        return e;
    }

    private static int intOr(EditText e, int fallback) {
        try { return Integer.parseInt(e.getText().toString().trim()); } catch (NumberFormatException x) { return fallback; }
    }

    interface IntConsumer { void accept(int i); }

    private View segmented(String[] options, int selected, IntConsumer onPick) {
        LinearLayout rowL = new LinearLayout(this);
        for (int i = 0; i < options.length; i++) {
            final int idx = i;
            Button b = new Button(this);
            b.setText(options[i]);
            b.setAllCaps(false);
            b.setTextSize(13);
            if (i == selected) { b.setBackgroundColor(0xFF1B5E20); b.setTextColor(Color.WHITE); }
            b.setOnClickListener(v -> onPick.accept(idx));
            rowL.addView(b, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        }
        return rowL;
    }

    private static String name(String[] table, int v) { return v > 0 && v < table.length ? table[v] : "mode " + v; }

    private static String shortOf(String uuid) {
        if (uuid.startsWith("0000") && uuid.endsWith("-0000-1000-8000-00805f9b34fb")) return uuid.substring(4, 8).toUpperCase(Locale.ROOT);
        return uuid.length() > 8 ? uuid.substring(0, 8) : uuid;
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }
}
