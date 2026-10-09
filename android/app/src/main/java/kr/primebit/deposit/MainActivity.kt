package kr.primebit.deposit

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread

/** 설정 화면: 서버 주소 / 비밀키 / 권한 / 연결 테스트 */
class MainActivity : Activity() {
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val p = Sender.prefs(this)
        val pad = (16 * resources.displayMetrics.density).toInt()

        val url = EditText(this).apply {
            hint = "서버 주소 (https://primebit.krl.kr)"
            setText(p.getString("url", ""))
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        val secret = EditText(this).apply {
            hint = "비밀키 (서버 .env 의 DEVICE_SECRET)"
            setText(p.getString("secret", ""))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        status = TextView(this).apply { setPadding(0, pad, 0, 0) }

        fun btn(label: String, onClick: () -> Unit) = Button(this).apply {
            text = label
            setOnClickListener { onClick() }
        }

        val save = {
            p.edit().putString("url", url.text.toString().trim()).putString("secret", secret.text.toString().trim()).apply()
        }

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(TextView(context).apply { text = "PrimeBIT 입금감지"; textSize = 22f })
            addView(TextView(context).apply { text = "은행 입금 문자/푸시를 서버로 전달해 자동 충전을 처리합니다." })
            addView(url)
            addView(secret)
            addView(btn("저장") { save(); refresh() })
            addView(btn("① 알림 접근 권한 열기") { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) })
            addView(btn("② 문자(SMS) 수신 권한 허용") { requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS), 1) })
            addView(btn("③ 배터리 최적화 해제 화면 열기") { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) })
            addView(btn("서버 연결 테스트") {
                save()
                status.text = "테스트 중..."
                thread { val r = Sender.test(this@MainActivity); runOnUiThread { status.text = r } }
            })
            addView(btn("대기 중인 알림 재전송") { thread { Sender.flush(this@MainActivity); runOnUiThread { refresh() } } })
            addView(status)
        }
        setContentView(ScrollView(this).apply { addView(col) })
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val listener = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")?.contains(packageName) == true
        val sms = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val queued = org.json.JSONArray(Sender.prefs(this).getString("queue", "[]")).length()
        status.text = "알림 접근: ${if (listener) "✅" else "❌"}\n문자 수신: ${if (sms) "✅" else "❌"}\n전송 대기: ${queued}건"
    }
}
