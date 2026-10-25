package io.github.genmnz.warden;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Remembers earbuds you've connected to: nickname, what Melad learned (chip, model,
 * firmware, last battery), how long it's been connected in total, and any rule you
 * taught it. One SharedPreferences entry per device, keyed by Bluetooth address.
 */
final class History {
    private History() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("buds", Context.MODE_PRIVATE);
    }

    private static Earbuds.BudRecord get(Context c, String mac) {
        if (mac == null) return null;
        Earbuds.BudRecord r = Earbuds.BudRecord.parse(prefs(c).getString("d_" + mac, null));
        if (r == null) { r = new Earbuds.BudRecord(); r.mac = mac; }
        return r;
    }

    private static void put(Context c, Earbuds.BudRecord r) {
        if (r == null || r.mac == null || r.mac.isEmpty()) return;
        prefs(c).edit().putString("d_" + r.mac, r.serialize()).apply();
    }

    /** Record that we're looking at this device now. */
    static synchronized void seen(Context c, String mac, String name, String chip) {
        Earbuds.BudRecord r = get(c, mac);
        if (r == null) return;
        if (r.name.isEmpty() && name != null) r.name = name;
        if (chip != null && !chip.isEmpty()) r.chip = chip;
        r.lastSeen = System.currentTimeMillis();
        put(c, r);
    }

    static synchronized void setBattery(Context c, String mac, String battery) {
        Earbuds.BudRecord r = get(c, mac);
        if (r == null) return;
        r.lastBattery = battery;
        r.lastSeen = System.currentTimeMillis();
        put(c, r);
    }

    static synchronized void setDeviceInfo(Context c, String mac, String model, String firmware) {
        Earbuds.BudRecord r = get(c, mac);
        if (r == null) return;
        if (model != null && !model.isEmpty()) r.model = model;
        if (firmware != null && !firmware.isEmpty()) r.firmware = firmware;
        put(c, r);
    }

    static synchronized void addConnectedTime(Context c, String mac, long ms) {
        if (ms <= 0) return;
        Earbuds.BudRecord r = get(c, mac);
        if (r == null) return;
        r.connectedMs += ms;
        put(c, r);
    }

    static synchronized void rename(Context c, String mac, String name) {
        Earbuds.BudRecord r = get(c, mac);
        if (r == null) return;
        r.name = Earbuds.BudRecord.clean(name);
        put(c, r);
    }

    static synchronized void setRule(Context c, String mac, Earbuds.CustomRule rule) {
        Earbuds.BudRecord r = get(c, mac);
        if (r == null) return;
        r.rule = rule;
        put(c, r);
    }

    static Earbuds.CustomRule rule(Context c, String mac) {
        Earbuds.BudRecord r = get(c, mac);
        return r == null ? null : r.rule;
    }

    static Earbuds.BudRecord record(Context c, String mac) { return get(c, mac); }

    static void forget(Context c, String mac) { prefs(c).edit().remove("d_" + mac).apply(); }

    /** All remembered devices, most recently seen first. */
    static List<Earbuds.BudRecord> all(Context c) {
        List<Earbuds.BudRecord> out = new ArrayList<>();
        for (String k : prefs(c).getAll().keySet()) {
            if (!k.startsWith("d_")) continue;
            Earbuds.BudRecord r = Earbuds.BudRecord.parse(prefs(c).getString(k, null));
            if (r != null) out.add(r);
        }
        Collections.sort(out, Comparator.comparingLong((Earbuds.BudRecord r) -> r.lastSeen).reversed());
        return out;
    }
}
