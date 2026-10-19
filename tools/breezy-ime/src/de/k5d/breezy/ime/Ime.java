package de.k5d.breezy.ime;

import android.content.*;
import android.inputmethodservice.InputMethodService;
import android.view.*;
import android.view.inputmethod.*;

/**
 * A keyboard for the platform scenarios: each broadcast makes one InputConnection call, as a real keyboard makes it.
 * adb shell am broadcast -a de.k5d.breezy.ime.OP --es op compose --es text に
 */
public class Ime extends InputMethodService {
  private final BroadcastReceiver rx = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) {
      InputConnection ic = getCurrentInputConnection();
      if (ic == null) return;
      String text = i.getStringExtra("text");
      switch (i.getStringExtra("op")) {
        case "compose": ic.setComposingText(text, 1); break;
        case "commit": ic.commitText(text, 1); break;
        case "finish": ic.finishComposingText(); break;
        case "region": ic.setComposingRegion(i.getIntExtra("start", 0), i.getIntExtra("end", 0)); break;
        case "delete": ic.deleteSurroundingText(i.getIntExtra("before", 1), i.getIntExtra("after", 0)); break;
        case "select": ic.setSelection(i.getIntExtra("start", 0), i.getIntExtra("end", 0)); break;
        case "key": {
          int code = i.getIntExtra("code", KeyEvent.KEYCODE_ENTER);
          ic.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
          ic.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
          break;
        }
      }
    }
  };

  @Override public void onCreate() {
    super.onCreate();
    registerReceiver(rx, new IntentFilter("de.k5d.breezy.ime.OP"), RECEIVER_EXPORTED);
  }

  @Override public void onDestroy() {
    unregisterReceiver(rx);
    super.onDestroy();
  }

  /** As tall as a phone's keyboard, so that the page makes room for it as it does for one. */
  @Override public View onCreateInputView() {
    View v = new View(this);
    v.setMinimumHeight(700);
    v.setBackgroundColor(0xff202124);
    return v;
  }
}
