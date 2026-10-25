package io.github.genmnz.warden;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;
import java.util.Locale;

/**
 * "My earbuds": recognise cheap TWS buds that have no companion app, read their
 * battery, and (for JieLi chips) switch game mode / mic / ANC. Built in code,
 * no layout files, matching the rest of the app.
 */
public final class EarbudsActivity extends Activity implements EarbudLink.Listener {
    private static final int REQ_BT = 7;

    private EarbudLink link;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private LinearLayout root, devices, controls;
    private TextView statusLine, batteryLine, chipLine, logView;
    private final StringBuilder logBuf = new StringBuilder();
    private Earbuds.JieliInfo info;
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

    @Override protected void onPause() {
        link.stopScan();
        super.onPause();
    }

    @Override protected void onDestroy() {
        link.disconnect();
        link.stopScan();
        super.onDestroy();
    }

    private void build() {
        root.removeAllViews();
        root.addView(small("Reads battery and controls for earbuds with no companion app. "
                + "Battery shows from a quick scan (case open). For JieLi earbuds, connect below for live battery, game mode and ANC."));

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

        header("Paired earbuds");
        root.addView(small("Tap a device to connect for live battery and controls (JieLi chips)."));
        devices = new LinearLayout(this);
        devices.setOrientation(LinearLayout.VERTICAL);
        root.addView(devices);
        root.addView(button("Refresh list", v -> listDevices()));
        listDevices();

        controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.VERTICAL);
        root.addView(controls);

        header("Activity");
        logView = small("");
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setTextSize(11);
        root.addView(logView);
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
    }

    // ------------------------------------------------------------------ devices + controls

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
            Button b = button(name + "\n" + mac, v -> {
                log("Connecting to " + name);
                link.connect(mac);
            });
            b.setAllCaps(false);
            devices.addView(b);
        }
    }

    private void rebuildControls() {
        if (controls == null) return;
        controls.removeAllViews();
        if (info == null || !link.isAuthed()) return;

        TextView h = big("Controls", 18);
        h.setPadding(0, dp(24), 0, dp(6));
        controls.addView(h);

        if (info.workMode > 0) {
            boolean gaming = info.workMode == 2;
            controls.addView(label("Game mode (low latency)"));
            controls.addView(segmented(new String[]{"Normal", "Gaming"}, gaming ? 1 : 0,
                    i -> link.setGameMode(i == 1)));
        }
        if (link.ancAvailable()) {
            controls.addView(label("Noise control"));
            controls.addView(segmented(ANC, -1, link::setAnc));
        }
        if (info.micChannel > 0) {
            controls.addView(label("Microphone: " + name(MIC, info.micChannel)));
            controls.addView(segmented(new String[]{"Auto", "Left", "Right"}, info.micChannel - 1,
                    i -> link.setMicChannel(i + 1)));
        }
        if (info.workMode <= 0 && !link.ancAvailable() && info.micChannel <= 0) {
            controls.addView(small("This firmware reports battery but no adjustable modes."));
        }
        controls.addView(button("Disconnect", v -> { link.disconnect(); info = null; rebuildControls(); }));
    }

    // ------------------------------------------------------------------ listener callbacks (main thread)

    @Override public void status(String text) {
        if (statusLine != null) statusLine.setText(text);
    }

    @Override public void battery(Earbuds.Battery b) {
        if (batteryLine == null) return;
        batteryLine.setText(b.toString());
        StringBuilder sb = new StringBuilder();
        if (!b.model.isEmpty()) sb.append(b.model);
        if (!b.source.isEmpty()) sb.append(sb.length() > 0 ? "  ·  " : "").append(b.source);
        chipLine.setText(sb);
    }

    @Override public void info(Earbuds.JieliInfo i) {
        info = i;
        StringBuilder sb = new StringBuilder();
        if (i.name != null) sb.append(i.name);
        if (i.vid >= 0) sb.append(sb.length() > 0 ? "  ·  " : "").append(String.format(Locale.ROOT, "VID %04X PID %04X", i.vid, i.pid));
        if (i.workMode > 0) sb.append("  ·  ").append(name(WORK_MODE, i.workMode));
        if (sb.length() > 0) chipLine.setText(sb);
        rebuildControls();
    }

    @Override public void log(String line) {
        logBuf.insert(0, line + "\n");
        if (logBuf.length() > 2000) logBuf.setLength(2000);
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

    interface IntConsumer { void accept(int i); }

    /** A row of buttons acting as a single choice; the selected one is highlighted. */
    private View segmented(String[] options, int selected, IntConsumer onPick) {
        LinearLayout row = new LinearLayout(this);
        for (int i = 0; i < options.length; i++) {
            final int idx = i;
            Button b = new Button(this);
            b.setText(options[i]);
            b.setAllCaps(false);
            b.setTextSize(13);
            if (i == selected) {
                b.setBackgroundColor(0xFF1B5E20);
                b.setTextColor(Color.WHITE);
            }
            b.setOnClickListener(v -> onPick.accept(idx));
            row.addView(b, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        }
        return row;
    }

    private static String name(String[] table, int v) { return v > 0 && v < table.length ? table[v] : "mode " + v; }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }
}
