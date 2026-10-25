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
import android.widget.Switch;
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
    private Ui u;
    private TextView[] banner;
    private TextView batteryLine, chipLine, diagLine, devInfoLine, classicLine, lookalikeLine, logView;
    private String noControlsWhy;
    private boolean autoPicked;
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
        CrashLog.install(this);
        if (getActionBar() != null) getActionBar().hide();
        link = new EarbudLink(this);
        link.setListener(this);
        u = new Ui(this);
        root = u.page(this);
        build();
        CrashLog.offer(this);
    }

    @Override protected void onResume() {
        super.onResume();
        if (ensurePerms()) start();
    }

    @Override protected void onPause() { link.stopScan(); super.onPause(); }

    @Override protected void onDestroy() { link.close(); super.onDestroy(); }

    private void build() {
        root.removeAllViews();
        u.title(root, "My earbuds", "Any buds, recognised or not · battery · controls · Lab");
        if (!link.ready()) {
            banner = u.banner(root);
            u.setBanner(banner, "Bluetooth is off", "Turn Bluetooth on, then come back.", Ui.State.WARN);
            return;
        }
        banner = u.banner(root);
        u.setBanner(banner, "Looking for your earbuds…", "", Ui.State.OFF);

        u.section(root, "Battery");
        LinearLayout bc = u.card(root);
        batteryLine = u.tv("—", 30, u.text, true);
        batteryLine.setPadding(0, dp(12), 0, 0);
        bc.addView(batteryLine);
        chipLine = u.tv("Open the case or start playing to read it", 13, u.sub, false);
        bc.addView(chipLine);
        diagLine = u.tv("", 13, u.sub, false);
        diagLine.setPadding(0, dp(4), 0, 0);
        bc.addView(diagLine);
        devInfoLine = u.tv("", 13, u.sub, false);
        devInfoLine.setPadding(0, dp(2), 0, dp(12));
        bc.addView(devInfoLine);

        u.section(root, "What these buds are");
        LinearLayout rc = u.card(root);
        classicLine = u.tv("Tap your earbuds below.", 14, u.text, false);
        classicLine.setPadding(0, dp(12), 0, dp(12));
        rc.addView(classicLine);
        lookalikeLine = u.notice(root, Ui.State.WARN);

        controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.VERTICAL);
        root.addView(controls);

        u.section(root, "Paired devices");
        devices = u.card(root);
        LinearLayout tools = u.card(root);
        LinearLayout.LayoutParams tlp = (LinearLayout.LayoutParams) tools.getLayoutParams();
        tlp.topMargin = dp(10);
        u.buttons(tools, "Refresh", (View.OnClickListener) v -> { listDevices(); listHistory(); },
                "Inspector", (View.OnClickListener) v -> showInspector());
        u.buttons(tools, "Lab", (View.OnClickListener) v -> openLab(),
                "Rename / forget", (View.OnClickListener) v -> renameOrForget());

        u.section(root, "History");
        history = u.card(root);

        u.section(root, "Activity");
        LinearLayout lc = u.card(root);
        logView = u.tv("", 11, u.sub, false);
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setPadding(0, dp(10), 0, dp(10));
        lc.addView(logView);

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
        if (batteryLine == null) build();
        link.open();
        link.startScan();
        listDevices();
        listHistory();
        // auto-detect the buds you're listening on. Android reports audio connections a moment
        // after the screen opens, so check again shortly.
        autoPick();
        ui.postDelayed(this::autoPick, 800);
        ui.postDelayed(this::autoPick, 2500);
    }

    private void autoPick() {
        if (autoPicked || connectedMac != null || isFinishing()) return;
        for (String[] d : link.paired()) {
            if ("playing".equals(d[2])) {
                autoPicked = true;
                log("Auto-detected " + d[0] + " (playing now)");
                connect(d[1], d[0]);
                listDevices();
                return;
            }
        }
    }

    // ------------------------------------------------------------------ device + history lists

    private void listDevices() {
        if (devices == null) return;
        devices.removeAllViews();
        List<String[]> paired = link.paired();
        if (paired.isEmpty()) {
            u.row(devices, "No paired devices", "Melad can't see any. Allow \"Nearby devices\" for Melad, "
                    + "and pair your earbuds in Settings → Bluetooth.", null);
            return;
        }
        for (String[] d : paired) {
            final String name = d[0], mac = d[1];
            boolean playing = "playing".equals(d[2]);
            String tag = playing ? "▶ playing now" : "audio".equals(d[2]) ? "audio device" : "other device";
            boolean selected = mac.equals(connectedMac);
            TextView sub = u.link(devices, (selected ? "● " : "") + name, mac + "  ·  " + tag, v -> connect(mac, name));
            if (playing) sub.setTextColor(u.accent);
        }
    }

    private void listHistory() {
        if (history == null) return;
        history.removeAllViews();
        List<Earbuds.BudRecord> all = History.all(this);
        if (all.isEmpty()) { u.row(history, "Nothing yet", "Devices you open here are remembered.", null); return; }
        for (Earbuds.BudRecord r : all) {
            StringBuilder sb = new StringBuilder();
            if (!r.chip.isEmpty()) sb.append(r.chip).append(" chip · ");
            if (!r.lastBattery.isEmpty() && !r.lastBattery.equals("unknown")) sb.append("last ").append(r.lastBattery).append(" · ");
            if (r.connectedMs > 0) sb.append("connected ").append(Earbuds.uptime(r.connectedMs)).append(" in total · ");
            if (r.rule != null && r.rule.usable()) sb.append("taught rule · ");
            sb.append("seen ").append(android.text.format.DateUtils.getRelativeTimeSpanString(r.lastSeen));
            final String mac = r.mac, name = r.name.isEmpty() ? r.mac : r.name;
            u.link(history, name, sb.toString(), v -> connect(mac, name));
        }
    }

    private void connect(String mac, String name) {
        connectedMac = mac;
        connectedName = name;
        info = null;
        rebuildControls();
        noControlsWhy = null;
        log("Connecting to " + name);
        link.connect(mac);
        listDevices();
        ui.postDelayed(this::listHistory, 600);
    }

    private void rebuildControls() {
        if (controls == null) return;
        controls.removeAllViews();
        if (info != null && link.isAuthed()) {
            u.section(controls, "Controls");
            LinearLayout c = u.card(controls);
            if (info.workMode > 0) {
                Switch game = u.toggle(info.workMode == 2);
                game.setOnCheckedChangeListener((v, on) -> link.setGameMode(on));
                u.row(c, "Game mode", info.workMode == 2 ? "On · lowest latency for games and video"
                        : "Off · normal latency, best sound and battery", game);
            }
            if (link.ancAvailable()) {
                u.row(c, "Noise control", "Choose below", null);
                c.addView(segmented(ANC, -1, link::setAnc));
            }
            if (info.micChannel > 0) {
                u.row(c, "Microphone", "Now: " + name(MIC, info.micChannel), null);
                c.addView(segmented(new String[]{"Auto", "Left", "Right"}, info.micChannel - 1, i -> link.setMicChannel(i + 1)));
            }
            if (info.workMode <= 0 && !link.ancAvailable() && info.micChannel <= 0)
                u.row(c, "No adjustable modes", "This firmware reports battery but nothing to switch.", null);
            u.buttons(c, "Disconnect", (View.OnClickListener) v -> { link.disconnect(); info = null; rebuildControls(); listHistory(); });
        } else if (noControlsWhy != null) {
            u.section(controls, "Controls");
            LinearLayout c = u.card(controls);
            u.row(c, "No game-mode switch for these buds",
                    "Melad asked the chip in every way it knows, and " + noControlsWhy + ". "
                            + "So there's nothing it can switch remotely yet. On most clones, game mode is toggled on the "
                            + "buds themselves (often 3 taps, or a long hold on both): you'll hear a tone or voice prompt.", null);
            u.row(c, "Help Melad learn them", "Open Lab → Classic channel and watch for bytes when you tap the buds, "
                    + "then send me what Activity shows.", null);
        }
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

    /** The Lab: probe the buds over Classic channels or LE characteristics, then teach a rule. */
    private void openLab() {
        if (connectedMac == null) { toast("Tap your earbuds first"); return; }
        final List<String> channels = link.classicChannels();
        final List<String[]> chars = link.labChars();
        List<String> items = new java.util.ArrayList<>();
        final List<Runnable> acts = new java.util.ArrayList<>();
        if (link.channelOpen()) {
            items.add("Send hex on the open Classic channel…");
            acts.add(() -> sendHexDialog(null));
            items.add("Close Classic channel");
            acts.add(link::closeChannel);
        }
        for (String u : channels) {
            items.add("Classic channel · " + labelForClassic(u));
            acts.add(() -> link.openChannel(u));
        }
        for (String[] c : chars) {
            items.add("LE · " + c[0] + "  [" + c[2] + "]");
            acts.add(() -> labActions(c));
        }
        if (items.isEmpty()) {
            new AlertDialog.Builder(this).setTitle("Lab")
                    .setMessage("These buds expose no control channel Melad can open yet — no vendor channel over Classic, "
                            + "and no LE link. Battery still shows if the buds report it to Android or in their advertisement.")
                    .setPositiveButton("OK", null).show();
            return;
        }
        new AlertDialog.Builder(this).setTitle("Lab — pick a channel")
                .setItems(items.toArray(new String[0]), (d, which) -> acts.get(which).run())
                .setNeutralButton("Teach battery rule", (d, w) -> teachRuleDialog())
                .setNegativeButton("Close", null).show();
    }

    private String labelForClassic(String uuid) {
        String n = Earbuds.classicService(uuid);
        return (n == null ? "" : n + " ") + uuid.substring(0, 8);
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

    /** uuid == null means the open Classic channel. */
    private void sendHexDialog(String uuid) {
        EditText in = new EditText(this);
        in.setHint("e.g. 05 5A 02 00 08 1E");
        in.setSingleLine();
        new AlertDialog.Builder(this).setTitle("Send bytes")
                .setMessage("Hex to write to " + (uuid == null ? "the Classic channel" : uuid)
                        + ". Replies show in Activity. Only send what you understand — this talks straight to the buds.")
                .setView(in)
                .setPositiveButton("Send", (d, w) -> {
                    byte[] data = Earbuds.unhex(in.getText().toString());
                    if (data.length == 0) { toast("Enter some hex"); return; }
                    if (uuid == null) link.channelWrite(data); else link.labWrite(uuid, data);
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

    @Override public void status(String text) {
        if (banner == null) return;
        Ui.State st = link.isAuthed() ? Ui.State.ON
                : text.startsWith("Scan failed") || text.contains("refused") ? Ui.State.WARN : Ui.State.OFF;
        String head = link.isAuthed() ? "Connected · full control"
                : connectedName != null ? connectedName : "Earbuds";
        u.setBanner(banner, head, text, st);
    }

    @Override public void noControls(String why) {
        noControlsWhy = why;
        rebuildControls();
    }

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

    @Override public void classic(EarbudLink.ClassicReport r) {
        if (classicLine == null) return;
        StringBuilder sb = new StringBuilder();
        sb.append(r.name).append(r.playing ? "  ·  ▶ playing audio now" : "  ·  not connected for audio").append('\n');
        sb.append("Chip: ").append(r.verdict.isEmpty()
                ? (link.isAuthed() ? "JieLi (it answered the JieLi protocol)" : "not identified from its services (checking…)") : r.verdict);
        if (!r.vendor.isEmpty() && !r.vendor.equals(r.verdict)) sb.append("  ·  radio by ").append(r.vendor);
        sb.append('\n');
        if (!r.claims.isEmpty()) sb.append("Says it is: ").append(r.claims).append('\n');
        if (!r.type.isEmpty()) sb.append("Bluetooth: ").append(r.type).append('\n');
        if (r.hfpBattery >= 0) sb.append("Headset battery reported to Android: ").append(r.hfpBattery).append("%\n");
        if (!r.services.isEmpty()) {
            sb.append("Offers: ");
            for (int i = 0; i < r.services.size(); i++) sb.append(i > 0 ? ", " : "").append(r.services.get(i)[0]);
            sb.append('\n');
        }
        sb.append(r.vendorChannels.isEmpty()
                ? "No control channel over Classic Bluetooth."
                : "Has a control channel · Melad is asking it which protocol it speaks.");
        classicLine.setText(sb);
        lookalikeLine.setText(r.lookalike == null ? "" : r.lookalike);
        lookalikeLine.setVisibility(r.lookalike == null ? View.GONE : View.VISIBLE);
        if (!r.verdict.isEmpty() && chipLine.getText().length() == 0) chipLine.setText(r.verdict + " chip");
    }

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
        if (uuid.startsWith("classic:")) return "Classic " + shortOf(uuid.substring(8));
        if (uuid.startsWith("0000") && uuid.endsWith("-0000-1000-8000-00805f9b34fb")) return uuid.substring(4, 8).toUpperCase(Locale.ROOT);
        return uuid.length() > 8 ? uuid.substring(0, 8) : uuid;
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }
}
