package com.genmnz.holdfast;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/** Per-app location firewall: every app that asks for location or nearby scanning, and what it holds. */
public class AppsActivity extends Activity {
    private LinearLayout list;
    private boolean showSystem;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout body = Ui.column(this);
        Ui.page(this, body);
        body.addView(Ui.secondary(this, "Apps that ask for location or nearby scanning. Tap one to deny it and, if you like, "
                + "hold it denied. Device Owner locks the permission so the app can't ask again; Shizuku revokes it and sets "
                + "app ops to ignore. Test one app at a time: some apps crash without location."));
        CheckBox sys = new CheckBox(this);
        sys.setText("Show system apps");
        sys.setOnCheckedChangeListener((x, on) -> {
            showSystem = on;
            refresh();
        });
        body.addView(sys);
        list = Ui.column(this);
        body.addView(list);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void refresh() {
        list.removeAllViews();
        list.addView(Ui.secondary(this, "Reading apps…"));
        boolean sys = showSystem;
        Ui.bg(this, () -> {
            PackageManager pm = getPackageManager();
            List<Object[]> rows = new ArrayList<>();
            for (PackageInfo pi : pm.getInstalledPackages(PackageManager.GET_PERMISSIONS)) {
                if (pi.requestedPermissions == null || pi.packageName.equals(getPackageName())) continue;
                boolean isSys = (pi.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
                boolean held = Store.isHeld(this, "app:" + pi.packageName);
                if (isSys && !sys && !held) continue;
                boolean asks = false;
                for (String p : pi.requestedPermissions) if (Arrays.asList(Controls.APP_PERMS).contains(p)) asks = true;
                if (!asks) continue;
                Controls.AppCtl c = new Controls.AppCtl(this, pi.packageName);
                rows.add(new Object[]{c, c.read(this), isSys});
            }
            rows.sort((x, y) -> {
                boolean gx = Boolean.FALSE.equals(((Control.State) x[1]).ok), gy = Boolean.FALSE.equals(((Control.State) y[1]).ok);
                if (gx != gy) return gx ? -1 : 1;
                return ((Control) x[0]).title.toLowerCase(Locale.ROOT).compareTo(((Control) y[0]).title.toLowerCase(Locale.ROOT));
            });
            return rows;
        }, rows -> {
            list.removeAllViews();
            int granted = 0;
            for (Object[] r : rows) if (Boolean.FALSE.equals(((Control.State) r[1]).ok)) granted++;
            list.addView(Ui.heading(this, rows.size() + " apps ask · " + granted + " currently allowed"));
            for (Object[] r : rows) list.addView(row((Control) r[0], (Control.State) r[1], (Boolean) r[2]));
        });
    }

    private View row(Control c, Control.State s, boolean sys) {
        LinearLayout r = new LinearLayout(this);
        r.setGravity(Gravity.CENTER_VERTICAL);
        int p = Ui.dp(this, 8);
        r.setPadding(0, p, 0, p);
        // Here ✓ means "blocked" (what you want), ✗ means "has location".
        TextView mark = Ui.text(this, Ui.stateMark(s.ok), 20);
        mark.setTextColor(Ui.stateColor(s.ok));
        mark.setTypeface(Typeface.DEFAULT_BOLD);
        mark.setGravity(Gravity.CENTER);
        r.addView(mark, new LinearLayout.LayoutParams(Ui.dp(this, 36), -2));
        LinearLayout col = Ui.column(this);
        col.addView(Ui.text(this, c.title + (sys ? "  (system)" : ""), 15));
        col.addView(Ui.secondary(this, ((Controls.AppCtl) c).pkg + "\n" + s.value
                + (Store.isHeld(this, c.id) ? " · held" : "")));
        r.addView(col, new LinearLayout.LayoutParams(0, -2, 1));
        return Ui.clickable(this, r, v -> ControlUi.details(this, c, this::refresh));
    }
}
