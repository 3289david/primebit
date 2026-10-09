package kr.primebit.deposit

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** 은행/토스 등 앱의 푸시 알림 중 '입금'이 포함된 것만 서버로 전달 */
class NotifService : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        val ex = sbn.notification.extras
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = ex.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            ?: ex.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
        val full = "$title $text".trim()
        if (!Filter.looksLikeDeposit(full)) return
        Sender.enqueue(this, full, sbn.postTime)
    }
}
