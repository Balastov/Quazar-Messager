package ru.quazarmsg.app;

import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

/**
 * Экран входящего звонка поверх блокировки (полноэкранное уведомление). Свой, лёгкий — без загрузки
 * всего Quazar: имя звонящего, «Отклонить» и «Принять». «Отклонить» работает без разблокировки,
 * «Принять» сначала просит разблокировать телефон (дальше открывается весь Quazar) и принимает звонок
 * там. Закрывается сам, когда звонок кончился.
 */
public class IncomingCallActivity extends AppCompatActivity {
    static final String ACTION_ANSWER = "ru.quazarmsg.app.ANSWER_CALL";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Bundle extras = new Bundle();
    private TextView hint;
    private boolean receiving;

    private final BroadcastReceiver ended = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (callId() != null && callId().equals(intent.getStringExtra("callId"))) finish();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        ContextCompat.registerReceiver(this, ended, new IntentFilter(IncomingCall.ACTION_ENDED),
            ContextCompat.RECEIVER_NOT_EXPORTED);
        receiving = true;
        load(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        load(intent);
    }

    private void load(Intent intent) {
        extras = intent.getExtras() != null ? intent.getExtras() : new Bundle();
        long left = IncomingCall.endsAt(extras) - System.currentTimeMillis();
        if (callId() == null || left <= 0) {
            finish();
            return;
        }
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::finish, left);
        setContentView(layout());
        // «Принять» на самом уведомлении — сразу к ответу.
        if (ACTION_ANSWER.equals(intent.getAction())) answer();
    }

    private String callId() {
        return extras.getString("callId");
    }

    private View layout() {
        boolean video = "1".equals(extras.getString("video"));
        String name = extras.getString("callerName", "Собеседник");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.quazar_background));
        root.setPadding(dp(24), dp(96), dp(24), dp(64));

        TextView kind = text(video ? "Входящий видеозвонок" : "Входящий звонок", 16, 0xB3FFFFFF, false);
        kind.setGravity(Gravity.CENTER);
        root.addView(kind, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView avatar = text(name.isEmpty() ? "?" : name.substring(0, 1).toUpperCase(), 44, Color.WHITE, true);
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(ContextCompat.getColor(this, R.color.quazar_accent));
        avatar.setBackground(circle);
        LinearLayout.LayoutParams avatarSize = new LinearLayout.LayoutParams(dp(112), dp(112));
        avatarSize.topMargin = dp(40);
        root.addView(avatar, avatarSize);

        TextView title = text(name, 28, Color.WHITE, true);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        titleParams.topMargin = dp(24);
        root.addView(title, titleParams);

        hint = text("", 14, 0xB3FFFFFF, false);
        hint.setGravity(Gravity.CENTER);
        root.addView(hint, titleParams);

        View spacer = new View(this);
        root.addView(spacer, new LinearLayout.LayoutParams(0, 0, 1f));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        buttons.addView(roundButton("Отклонить", 0xFFE5484D, v -> decline()), weight());
        buttons.addView(roundButton("Принять", 0xFF34D399, v -> answer()), weight());
        root.addView(buttons, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return root;
    }

    private LinearLayout.LayoutParams weight() {
        return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    }

    private View roundButton(String label, int color, View.OnClickListener click) {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        TextView circle = text(label.equals("Принять") ? "✆" : "✕", 30, Color.WHITE, true);
        circle.setGravity(Gravity.CENTER);
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.OVAL);
        shape.setColor(color);
        circle.setBackground(shape);
        circle.setContentDescription(label);
        circle.setClickable(true);
        circle.setFocusable(true);
        circle.setOnClickListener(click);
        column.addView(circle, new LinearLayout.LayoutParams(dp(76), dp(76)));
        TextView caption = text(label, 15, Color.WHITE, false);
        LinearLayout.LayoutParams captionParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        captionParams.topMargin = dp(10);
        column.addView(caption, captionParams);
        return column;
    }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private void decline() {
        sendBroadcast(new Intent(this, CallActionReceiver.class)
            .setAction(CallActionReceiver.ACTION_DECLINE).putExtras(extras));
        finish();
    }

    private void answer() {
        // Рингтон замолкает сразу — человек уже отвечает.
        android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
        if (manager != null && callId() != null) manager.cancel(IncomingCall.tag(callId()), IncomingCall.id(callId()));
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (keyguard != null && keyguard.isKeyguardLocked() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            hint.setText("Разблокируйте телефон, чтобы ответить");
            keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    openQuazar();
                }
            });
            return;
        }
        openQuazar();
    }

    /** Quazar примет звонок сам: те же данные, что у нажатия на уведомление, плюс action=accept. */
    private void openQuazar() {
        Intent intent = new Intent(this, MainActivity.class)
            .putExtras(extras)
            .putExtra("google.message_id", "call-accept-" + callId())
            .putExtra("action", "accept")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (receiving) unregisterReceiver(ended);
        super.onDestroy();
    }
}
