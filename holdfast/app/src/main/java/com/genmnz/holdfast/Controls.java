package com.genmnz.holdfast;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.UserManager;
import android.telephony.TelephonyManager;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Every control Holdfast knows, built fresh on each call (cheap). */
final class Controls {
    static final String M_LOCATION = "Location";
    static final String M_SCAN = "Scanning";
    static final String M_TIME = "Time zone";
    static final String M_APPS = "Ads & telemetry apps";
    static final String M_NET = "Network";
    static final String M_REGION = "Region (experimental, temporary)";
    static final String M_PERAPP = "Per-app location";

    private Controls() {}

    static List<Control> all(Context c) {
        List<Control> l = new ArrayList<>();
        l.add(new LocationCtl());
        l.add(new RestrictionCtl("lock_location", M_LOCATION, "Lock the location switch",
                UserManager.DISALLOW_CONFIG_LOCATION,
                "Stops anyone (including setup screens and 'Improve accuracy' prompts) from turning location on in Settings. Holdfast as Device Owner can still change it.",
                "You can't turn location on from the Quick Panel or Settings until you remove this here."));
        l.add(new RestrictionCtl("lock_share_location", M_LOCATION, "Block location sharing",
                UserManager.DISALLOW_SHARE_LOCATION,
                "Blocks turning on location sharing for this user.",
                "Apps can't be granted location sharing while this is on."));
        l.add(new SettingCtl("agps", M_LOCATION, "Assisted GPS (SUPL) off", Sx.GLOBAL, "assisted_gps_enabled", "0", "1", null,
                "Stops the GPS chip asking a carrier/SUPL server for help, which tells that server roughly where you are.",
                "First GPS fix is slower when you do use location."));

        l.add(new SettingCtl("wifi_scan", M_SCAN, "Wi-Fi scanning off", Sx.GLOBAL, "wifi_scan_always_enabled", "0", "1", null,
                "Stops apps and Google location services from scanning nearby Wi-Fi networks while Wi-Fi is off. Wi-Fi network lists are one of the main ways phones locate themselves.",
                "Google Maps may turn this back on during navigation; holding it puts it back."));
        l.add(new SettingCtl("ble_scan", M_SCAN, "Bluetooth scanning off", Sx.GLOBAL, "ble_scan_always_enabled", "0", "1", null,
                "Stops background Bluetooth beacon scanning while Bluetooth is off.",
                "Same as Wi-Fi scanning: Maps and setup flows may re-enable it."));
        l.add(new SettingCtl("nearby_scan", M_SCAN, "Samsung nearby device scanning off", Sx.SYSTEM, "nearby_scanning_enabled", "0", "1", null,
                "Samsung's own scanning for nearby Galaxy devices.",
                "Quick Share discovery and the Galaxy Buds pop-up stop working."));
        l.add(new SettingCtl("nearby_perm", M_SCAN, "Samsung nearby scanning permission off", Sx.SYSTEM, "nearby_scanning_permission_allowed", "0", "1", null,
                "Companion switch to nearby device scanning.",
                "Same as above."));

        l.add(new SettingCtl("auto_tz", M_TIME, "Automatic time zone off", Sx.GLOBAL, "auto_time_zone", "0", "1", null,
                "Automatic time zone listens to the cell network (NITZ/MCC) and location. Turning it off removes a passive location use.",
                "You set the time zone yourself, including when you travel.") {
            @Override
            void extra(Context c, String v, boolean before, List<Step> out) {
                boolean on = "1".equals(v);
                if (before) {
                    out.add(Step.api(Tier.DEVICE_OWNER, "Device Owner policy",
                            "DevicePolicyManager.setAutoTimeZoneEnabled(admin, " + on + ")",
                            x -> {
                                Privs.dpm(x).setAutoTimeZoneEnabled(Privs.admin(x), on);
                                return "";
                            }));
                } else {
                    out.add(Step.shell("time zone detector", "cmd time_zone_detector set_auto_detection_enabled " + on));
                }
            }
        });
        l.add(new RestrictionCtl("lock_datetime", M_TIME, "Lock date & time settings",
                UserManager.DISALLOW_CONFIG_DATE_TIME,
                "Stops the automatic time zone switch being turned back on.",
                "You can't change date, time or time zone in Settings until you remove this here."));
        l.add(new SettingCtl("geo_tz", M_TIME, "Location-based time zone off", Sx.SECURE, "location_time_zone_detection_enabled", "0", "1", null,
                "Android's location time zone detector looks up your time zone from location. Off means one less location reader.",
                "None if automatic time zone is already off.") {
            @Override
            void extra(Context c, String v, boolean before, List<Step> out) {
                if (!before) out.add(Step.shell("time zone detector",
                        "cmd time_zone_detector set_geo_detection_enabled " + "1".equals(v)));
            }
        });

        for (String[] p : PACKAGES) l.add(new PackageCtl(p[0], p[1], p[2]));

        l.add(new PrivateDnsCtl());
        l.add(new SimCountryCtl());

        for (String id : Store.held(c)) if (id.startsWith("app:")) l.add(new AppCtl(c, id.substring(4)));

        List<Control> out = new ArrayList<>();
        for (Control x : l) if (x.present(c)) out.add(x);
        return out;
    }

    static Control byId(Context c, String id) {
        if (id.startsWith("app:")) return new AppCtl(c, id.substring(4));
        for (Control x : all(c)) if (x.id.equals(id)) return x;
        return null;
    }

    /** Package, friendly name, what breaks. */
    static final String[][] PACKAGES = {
            {"com.samsung.android.ipsgeofence", "Samsung Visit In (geofencing)",
                    "Location triggers in Bixby Routines, SmartThings and Samsung Wallet stop working."},
            {"com.samsung.android.rubin.app", "Samsung Customization Service",
                    "Personalised suggestions in Samsung apps stop; Now Brief may show less."},
            {"com.samsung.android.mapsagent", "Samsung maps agent",
                    "Rarely noticed. Test one package at a time."},
            {"com.samsung.android.app.omcagent", "OMC agent (carrier/CSC config)",
                    "Carrier configuration pushes stop; may affect CSC or carrier updates."},
            {"com.sec.android.diagmonagent", "Samsung diagnostics agent",
                    "Reported to cause errors in Device Care and Samsung Members."},
            {"com.samsung.android.dqagent", "Samsung data quality agent",
                    "Usually nothing noticeable."},
            {"com.sec.android.app.chromecustomizations", "Chrome partner customisations",
                    "Usually nothing noticeable."},
    };

    // ---------------------------------------------------------------- settings key

    static class SettingCtl extends Control {
        final int ns;
        final String key, wantVal, dflt;
        final Boolean unsetOk;

        SettingCtl(String id, String module, String title, int ns, String key, String wantVal, String dflt,
                   Boolean unsetOk, String about, String effects) {
            super(id, module, title, key + " = " + wantVal, about, effects);
            this.ns = ns;
            this.key = key;
            this.wantVal = wantVal;
            this.dflt = dflt;
            this.unsetOk = unsetOk;
        }

        @Override
        State read(Context c) {
            Sx.Val v = Sx.read(c, ns, key);
            if (!v.readable) return new State("unreadable (" + v.via + ")", null);
            String via = "shell".equals(v.via) ? " (read via shell)" : "";
            if (v.raw == null) return new State("(unset)" + via, unsetOk);
            return new State(v.raw + via, wantVal.equals(v.raw));
        }

        @Override
        String snapshot(Context c) {
            Sx.Val v = Sx.read(c, ns, key);
            return v.readable && v.raw != null ? v.raw : null;
        }

        @Override
        List<Step> apply(Context c) {
            return steps(c, wantVal);
        }

        @Override
        List<Step> restore(Context c) {
            String o = Store.original(c, id);
            return steps(c, o != null && !Store.UNSET.equals(o) ? o : dflt);
        }

        List<Step> steps(Context c, String v) {
            List<Step> out = new ArrayList<>();
            extra(c, v, true, out);
            Tier t = ns == Sx.SYSTEM ? Tier.SYSTEM_SETTINGS : Tier.SECURE_SETTINGS;
            out.add(Step.api(t, "direct write", Sx.putLine(ns, key, v)
                            + "\n  (≙ adb shell " + Sx.shellLine(ns, key, v) + ")",
                    x -> {
                        Sx.put(x, ns, key, v);
                        return "";
                    }));
            out.add(Step.shell("settings command", Sx.shellLine(ns, key, v)));
            extra(c, v, false, out);
            return out;
        }

        /** Extra paths before (stronger) or after (weaker) the generic ones. */
        void extra(Context c, String v, boolean before, List<Step> out) {}

        @Override
        Uri[] watch() {
            return new Uri[]{Sx.uri(ns, key)};
        }
    }

    // ---------------------------------------------------------------- master location

    static final class LocationCtl extends Control {
        LocationCtl() {
            super("location", M_LOCATION, "Location off", "location disabled",
                    "The master location switch. Off stops GPS, network location and the fused provider for every app.",
                    "Find My Mobile, weather, maps and anything else that needs location stop working.");
        }

        @Override
        State read(Context c) {
            boolean on = c.getSystemService(LocationManager.class).isLocationEnabled();
            return new State(on ? "on" : "off", !on);
        }

        @Override
        List<Step> apply(Context c) {
            return steps(false);
        }

        @Override
        List<Step> restore(Context c) {
            return steps(!"off".equals(Store.original(c, id)));
        }

        private List<Step> steps(boolean on) {
            return Arrays.asList(
                    Step.api(Tier.DEVICE_OWNER, "Device Owner policy",
                            "DevicePolicyManager.setLocationEnabled(admin, " + on + ")",
                            x -> {
                                Privs.dpm(x).setLocationEnabled(Privs.admin(x), on);
                                return "";
                            }),
                    Step.shell("location command", "cmd location set-location-enabled " + on),
                    Step.api(Tier.SECURE_SETTINGS, "legacy location_mode write (may be ignored)",
                            Sx.putLine(Sx.SECURE, "location_mode", on ? "3" : "0"),
                            x -> {
                                Sx.put(x, Sx.SECURE, "location_mode", on ? "3" : "0");
                                return "";
                            }));
        }

        @Override
        Uri[] watch() {
            return new Uri[]{Sx.uri(Sx.SECURE, "location_mode")};
        }
    }

    // ---------------------------------------------------------------- user restriction

    static final class RestrictionCtl extends Control {
        final String key;

        RestrictionCtl(String id, String module, String title, String key, String about, String effects) {
            super(id, module, title, "restriction " + key + " set", about, effects);
            this.key = key;
        }

        @Override
        State read(Context c) {
            boolean set = c.getSystemService(UserManager.class).hasUserRestriction(key);
            return new State(set ? "set" : "not set", set);
        }

        @Override
        List<Step> apply(Context c) {
            return List.of(Step.api(Tier.DEVICE_OWNER, "Device Owner restriction",
                    "DevicePolicyManager.addUserRestriction(admin, \"" + key + "\")",
                    x -> {
                        Privs.dpm(x).addUserRestriction(Privs.admin(x), key);
                        return "";
                    }));
        }

        @Override
        List<Step> restore(Context c) {
            return List.of(Step.api(Tier.DEVICE_OWNER, "Device Owner restriction",
                    "DevicePolicyManager.clearUserRestriction(admin, \"" + key + "\")",
                    x -> {
                        Privs.dpm(x).clearUserRestriction(Privs.admin(x), key);
                        return "";
                    }));
        }
    }

    // ---------------------------------------------------------------- package freeze

    static final class PackageCtl extends Control {
        final String pkg;

        PackageCtl(String pkg, String name, String effects) {
            super("pkg:" + pkg, M_APPS, name, pkg + " suspended or disabled",
                    "Freezes " + pkg + ". Suspending is preferred: it is fully reversible and keeps the app's data.",
                    effects);
            this.pkg = pkg;
        }

        @Override
        boolean present(Context c) {
            try {
                c.getPackageManager().getApplicationInfo(pkg, PackageManager.MATCH_UNINSTALLED_PACKAGES
                        | PackageManager.MATCH_DISABLED_COMPONENTS);
                return true;
            } catch (PackageManager.NameNotFoundException e) {
                return false;
            }
        }

        @Override
        State read(Context c) {
            PackageManager pm = c.getPackageManager();
            try {
                ApplicationInfo ai = pm.getApplicationInfo(pkg, PackageManager.MATCH_UNINSTALLED_PACKAGES
                        | PackageManager.MATCH_DISABLED_COMPONENTS);
                boolean suspended = (ai.flags & ApplicationInfo.FLAG_SUSPENDED) != 0;
                int es = pm.getApplicationEnabledSetting(pkg);
                boolean disabled = !ai.enabled || es == PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                        || es == PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER;
                boolean hidden = false;
                DevicePolicyManager dpm = Privs.dpm(c);
                if (dpm.isDeviceOwnerApp(c.getPackageName())) hidden = dpm.isApplicationHidden(Privs.admin(c), pkg);
                List<String> s = new ArrayList<>();
                if (suspended) s.add("suspended");
                if (disabled) s.add("disabled");
                if (hidden) s.add("hidden");
                return new State(s.isEmpty() ? "active" : String.join(", ", s), suspended || disabled || hidden);
            } catch (Exception e) {
                return new State("unreadable: " + e.getMessage(), null);
            }
        }

        @Override
        List<Step> apply(Context c) {
            return Arrays.asList(
                    Step.api(Tier.DEVICE_OWNER, "suspend (reversible)",
                            "DevicePolicyManager.setPackagesSuspended(admin, [\"" + pkg + "\"], true)",
                            x -> suspend(x, true)),
                    Step.shell("disable for this user", "pm disable-user --user 0 " + pkg));
        }

        @Override
        List<Step> restore(Context c) {
            return Arrays.asList(
                    Step.api(Tier.DEVICE_OWNER, "unsuspend",
                            "DevicePolicyManager.setPackagesSuspended(admin, [\"" + pkg + "\"], false)",
                            x -> suspend(x, false)),
                    Step.shell("re-enable", "pm enable --user 0 " + pkg));
        }

        private String suspend(Context x, boolean on) throws Exception {
            String[] failed = Privs.dpm(x).setPackagesSuspended(Privs.admin(x), new String[]{pkg}, on);
            if (failed != null && failed.length > 0)
                throw new Exception("Android refused to " + (on ? "suspend " : "unsuspend ") + pkg
                        + " (it may be required by the system, a launcher or an admin app)");
            return "";
        }
    }

    // ---------------------------------------------------------------- private DNS

    static final class PrivateDnsCtl extends Control {
        PrivateDnsCtl() {
            super("private_dns", M_NET, "Private DNS locked to a host", "private_dns_mode = hostname",
                    "Sends all DNS over TLS to a host you choose and keeps it there.",
                    "Pick one DNS owner. If your ad-blocker already sets DNS, leave this alone.");
            paramPrompt = "DNS-over-TLS hostname, e.g. dns.quad9.net";
        }

        @Override
        State read(Context c) {
            String mode = Sx.get(c, Sx.GLOBAL, "private_dns_mode");
            String spec = Sx.get(c, Sx.GLOBAL, "private_dns_specifier");
            String host = param(c);
            String v = (mode == null ? "(default)" : mode) + ("hostname".equals(mode) ? " → " + spec : "");
            if (host == null) return new State(v + " · no host chosen", null);
            return new State(v, "hostname".equals(mode) && host.equals(spec));
        }

        @Override
        String snapshot(Context c) {
            return Sx.get(c, Sx.GLOBAL, "private_dns_mode") + "|" + Sx.get(c, Sx.GLOBAL, "private_dns_specifier");
        }

        @Override
        List<Step> apply(Context c) {
            String host = param(c);
            return Arrays.asList(
                    Step.api(Tier.DEVICE_OWNER, "Device Owner policy",
                            "DevicePolicyManager.setGlobalPrivateDnsModeSpecifiedHost(admin, \"" + host + "\")",
                            x -> {
                                int r = Privs.dpm(x).setGlobalPrivateDnsModeSpecifiedHost(Privs.admin(x), host);
                                if (r != DevicePolicyManager.PRIVATE_DNS_SET_NO_ERROR)
                                    throw new Exception(r == DevicePolicyManager.PRIVATE_DNS_SET_ERROR_HOST_NOT_SERVING
                                            ? host + " doesn't answer DNS-over-TLS" : "Android refused (code " + r + ")");
                                return "";
                            }),
                    new Step(Tier.SECURE_SETTINGS, "direct write", new String[]{
                            Sx.putLine(Sx.GLOBAL, "private_dns_specifier", host),
                            Sx.putLine(Sx.GLOBAL, "private_dns_mode", "hostname")},
                            x -> {
                                Sx.put(x, Sx.GLOBAL, "private_dns_specifier", host);
                                Sx.put(x, Sx.GLOBAL, "private_dns_mode", "hostname");
                                return "";
                            }),
                    Step.shell("settings command",
                            Sx.shellLine(Sx.GLOBAL, "private_dns_specifier", host),
                            Sx.shellLine(Sx.GLOBAL, "private_dns_mode", "hostname")));
        }

        @Override
        List<Step> restore(Context c) {
            String o = Store.original(c, id);
            String mode = "opportunistic", spec = "";
            if (o != null) {
                String[] p = o.split("\\|", -1);
                if (!"null".equals(p[0])) mode = p[0];
                if (p.length > 1 && !"null".equals(p[1])) spec = p[1];
            }
            String m = mode, s = spec;
            List<Step> out = new ArrayList<>();
            if ("opportunistic".equals(m)) out.add(Step.api(Tier.DEVICE_OWNER, "Device Owner policy",
                    "DevicePolicyManager.setGlobalPrivateDnsModeOpportunistic(admin)",
                    x -> {
                        Privs.dpm(x).setGlobalPrivateDnsModeOpportunistic(Privs.admin(x));
                        return "";
                    }));
            out.add(new Step(Tier.SECURE_SETTINGS, "direct write", new String[]{
                    Sx.putLine(Sx.GLOBAL, "private_dns_mode", m), Sx.putLine(Sx.GLOBAL, "private_dns_specifier", s)},
                    x -> {
                        Sx.put(x, Sx.GLOBAL, "private_dns_mode", m);
                        Sx.put(x, Sx.GLOBAL, "private_dns_specifier", s);
                        return "";
                    }));
            out.add(Step.shell("settings command", Sx.shellLine(Sx.GLOBAL, "private_dns_mode", m)));
            return out;
        }

        @Override
        Uri[] watch() {
            return new Uri[]{Sx.uri(Sx.GLOBAL, "private_dns_mode"), Sx.uri(Sx.GLOBAL, "private_dns_specifier")};
        }
    }

    // ---------------------------------------------------------------- SIM country override

    static final class SimCountryCtl extends Control {
        SimCountryCtl() {
            super("sim_country", M_REGION, "SIM country override (until reboot)", "SIM country = your code",
                    "Overrides the SIM country that apps see, through the carrier config of the data SIM. It does NOT change the network country (cell MCC), your IP or your account location, which decide ad targeting. A reboot always undoes it.",
                    "Samsung firmware may reject it. Calling/VoLTE can misbehave after a carrier config refresh. Restore clears every carrier config override.");
            holdable = false;
            paramPrompt = "Two-letter country code, e.g. us";
        }

        @Override
        State read(Context c) {
            String iso = c.getSystemService(TelephonyManager.class).getSimCountryIso();
            String want = param(c);
            return new State(iso == null || iso.isEmpty() ? "(none)" : iso, want == null ? null : want.equalsIgnoreCase(iso));
        }

        @Override
        List<Step> apply(Context c) {
            return List.of(Step.shell("carrier config override (temporary)",
                    "cmd phone cc set-value sim_country_iso_override_string " + param(c)));
        }

        @Override
        List<Step> restore(Context c) {
            return List.of(Step.shell("clear carrier config overrides", "cmd phone cc clear-values"));
        }
    }

    // ---------------------------------------------------------------- per-app location

    static final String[] APP_PERMS = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            "android.permission.BLUETOOTH_SCAN",
            "android.permission.NEARBY_WIFI_DEVICES",
    };
    static final String[] APP_OPS = {"COARSE_LOCATION", "FINE_LOCATION", "MONITOR_LOCATION",
            "MONITOR_HIGH_POWER_LOCATION", "WIFI_SCAN", "BLUETOOTH_SCAN"};

    static final class AppCtl extends Control {
        final String pkg;
        final List<String> perms = new ArrayList<>();
        boolean installed;

        AppCtl(Context c, String pkg) {
            super("app:" + pkg, M_PERAPP, label(c, pkg), "no location or scan permission",
                    "Denies " + pkg + " every location and nearby-scan permission it asks for.",
                    "The app can crash or nag. Google Play services asks again; holding it re-denies.");
            this.pkg = pkg;
            try {
                PackageInfo pi = c.getPackageManager().getPackageInfo(pkg, PackageManager.GET_PERMISSIONS);
                installed = true;
                if (pi.requestedPermissions != null)
                    for (String p : pi.requestedPermissions) if (Arrays.asList(APP_PERMS).contains(p)) perms.add(p);
            } catch (PackageManager.NameNotFoundException ignored) {
            }
        }

        static String label(Context c, String pkg) {
            try {
                PackageManager pm = c.getPackageManager();
                return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
            } catch (Exception e) {
                return pkg;
            }
        }

        @Override
        boolean present(Context c) {
            return installed;
        }

        @Override
        State read(Context c) {
            PackageManager pm = c.getPackageManager();
            List<String> granted = new ArrayList<>();
            for (String p : perms)
                if (pm.checkPermission(p, pkg) == PackageManager.PERMISSION_GRANTED) granted.add(shortName(p));
            String op = "?";
            boolean opBlocked = false;
            try {
                int uid = pm.getApplicationInfo(pkg, 0).uid;
                int m = c.getSystemService(AppOpsManager.class)
                        .unsafeCheckOpRawNoThrow(AppOpsManager.OPSTR_COARSE_LOCATION, uid, pkg);
                op = modeName(m);
                opBlocked = m == AppOpsManager.MODE_IGNORED || m == AppOpsManager.MODE_ERRORED;
            } catch (Exception ignored) {
            }
            String v = (granted.isEmpty() ? "nothing granted" : "granted: " + String.join(", ", granted))
                    + " · coarse op " + op;
            return new State(v, granted.isEmpty() || opBlocked);
        }

        @Override
        List<Step> apply(Context c) {
            List<String> lines = new ArrayList<>(), cmds = new ArrayList<>();
            for (String p : perms) {
                lines.add("DevicePolicyManager.setPermissionGrantState(admin, \"" + pkg + "\", \"" + p + "\", DENIED)");
                cmds.add("pm revoke " + pkg + " " + p);
            }
            for (String o : APP_OPS) cmds.add("appops set " + pkg + " " + o + " ignore");
            return Arrays.asList(
                    new Step(Tier.DEVICE_OWNER, "lock permissions denied", lines.toArray(new String[0]),
                            x -> grant(x, DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED)),
                    Step.shell("revoke + app ops ignore", cmds.toArray(new String[0])));
        }

        @Override
        List<Step> restore(Context c) {
            List<String> lines = new ArrayList<>(), cmds = new ArrayList<>();
            for (String p : perms)
                lines.add("DevicePolicyManager.setPermissionGrantState(admin, \"" + pkg + "\", \"" + p + "\", DEFAULT)");
            for (String o : APP_OPS) cmds.add("appops set " + pkg + " " + o + " default");
            return Arrays.asList(
                    new Step(Tier.DEVICE_OWNER, "unlock (stays denied until you grant it)", lines.toArray(new String[0]),
                            x -> grant(x, DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT)),
                    Step.shell("reset app ops (permissions stay denied)", cmds.toArray(new String[0])));
        }

        private String grant(Context x, int state) throws Exception {
            DevicePolicyManager dpm = Privs.dpm(x);
            StringBuilder bad = new StringBuilder();
            for (String p : perms)
                if (!dpm.setPermissionGrantState(Privs.admin(x), pkg, p, state)) bad.append(shortName(p)).append(' ');
            if (bad.length() > 0) throw new Exception("Android refused: " + bad.toString().trim());
            return "";
        }

        static String shortName(String p) {
            switch (p) {
                case Manifest.permission.ACCESS_FINE_LOCATION: return "precise";
                case Manifest.permission.ACCESS_COARSE_LOCATION: return "approximate";
                case Manifest.permission.ACCESS_BACKGROUND_LOCATION: return "background";
                case "android.permission.BLUETOOTH_SCAN": return "BT scan";
                case "android.permission.NEARBY_WIFI_DEVICES": return "Wi-Fi nearby";
            }
            return p;
        }

        static String modeName(int m) {
            switch (m) {
                case AppOpsManager.MODE_ALLOWED: return "allow";
                case AppOpsManager.MODE_IGNORED: return "ignore";
                case AppOpsManager.MODE_ERRORED: return "deny";
                case AppOpsManager.MODE_DEFAULT: return "default";
                case AppOpsManager.MODE_FOREGROUND: return "foreground";
            }
            return String.valueOf(m);
        }
    }
}
