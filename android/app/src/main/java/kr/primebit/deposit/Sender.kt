package kr.primebit.deposit

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 입금 알림을 서버로 전송. 실패하면 로컬 큐에 남겨두고 30초 뒤 재시도한다.
 * 서버는 내용 해시로 중복을 제거하므로 재전송해도 이중 지급되지 않는다.
 */
object Sender {
    private val exec = Executors.newSingleThreadScheduledExecutor()
    private const val PREFS = "primebit"

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun enqueue(ctx: Context, text: String, ts: Long) {
        val app = ctx.applicationContext
        exec.execute {
            val p = prefs(app)
            val q = JSONArray(p.getString("queue", "[]"))
            q.put(JSONObject().put("text", text).put("ts", ts))
            p.edit().putString("queue", q.toString()).apply()
            flush(app)
        }
    }

    fun flush(ctx: Context) {
        val p = prefs(ctx)
        val url = p.getString("url", "") ?: ""
        val secret = p.getString("secret", "") ?: ""
        if (url.isBlank() || secret.isBlank()) return
        val q = JSONArray(p.getString("queue", "[]"))
        val remain = JSONArray()
        for (i in 0 until q.length()) {
            val item = q.getJSONObject(i)
            if (remain.length() > 0 || !post(url, secret, item)) remain.put(item) // 순서 유지
        }
        p.edit().putString("queue", remain.toString()).apply()
        if (remain.length() > 0) exec.schedule({ flush(ctx) }, 30, TimeUnit.SECONDS)
    }

    private fun post(base: String, secret: String, item: JSONObject): Boolean = try {
        val body = JSONObject()
            .put("text", item.getString("text"))
            .put("ts", item.getLong("ts"))
            .put("device", android.os.Build.MODEL)
            .toString()
        val stamp = System.currentTimeMillis().toString()
        val conn = (URL(base.trimEnd('/') + "/api/deposit").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 10_000
            readTimeout = 10_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("X-Timestamp", stamp)
            setRequestProperty("X-Signature", hmac(secret, "$stamp.$body"))
        }
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val code = conn.responseCode
        conn.disconnect()
        code in 200..299 // 실패(키 불일치 포함)는 큐에 남아 설정을 고친 뒤 재전송된다
    } catch (e: Exception) {
        false
    }

    private fun hmac(secret: String, data: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /** 설정 화면의 '연결 테스트' — 입금 키워드가 없는 문구라 서버에서 ignored 로 응답 */
    fun test(ctx: Context): String {
        val p = prefs(ctx)
        val item = JSONObject().put("text", "PrimeBIT 연결 테스트").put("ts", System.currentTimeMillis())
        return if (post(p.getString("url", "") ?: "", p.getString("secret", "") ?: "", item)) "✅ 서버 연결 성공" else "❌ 연결 실패 (주소/비밀키/HTTPS 확인)"
    }
}
