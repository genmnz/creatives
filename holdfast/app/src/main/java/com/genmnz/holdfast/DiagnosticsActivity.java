package com.genmnz.holdfast;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Full plain-text report: device, privileges, every control's state and history, and the event log. */
public class DiagnosticsActivity extends Activity {
    private TextView report;
    private String text = "";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout body = Ui.column(this);
        Ui.page(this, body);
        body.addView(Ui.buttons(this,
                Ui.button(this, "Refresh", v -> refresh()),
                Ui.button(this, "Copy", v -> Ui.copy(this, "Holdfast diagnostics", text)),
                Ui.button(this, "Share…", v -> startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND)
                        .setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share diagnostics"))),
                Ui.button(this, "Clear log…", v -> new AlertDialog.Builder(this)
                        .setTitle("Clear the event log?")
                        .setMessage("Deletes the history of applies, restores and drifts. Settings on the phone don't change.")
                        .setNegativeButton("Cancel", null)
                        .setPositiveButton("Clear", (d, w) -> {
                            EventLog.clear(this);
                            refresh();
                        }).show())));
        body.addView(Ui.secondary(this, "Share stays on your phone unless you pick an app. The report contains your model, CSC and country codes."));
        report = Ui.mono(this, "Collecting…");
        body.addView(report);
        refresh();
    }

    private void refresh() {
        report.setText("Collecting…");
        Ui.bg(this, () -> Probe.report(this), s -> {
            text = s;
            report.setText(s);
        });
    }
}
