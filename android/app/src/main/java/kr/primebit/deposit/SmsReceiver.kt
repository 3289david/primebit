package kr.primebit.deposit

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        // 장문 문자는 여러 조각으로 오므로 합친다
        val text = msgs.joinToString("") { it.messageBody ?: "" }
        val ts = msgs.firstOrNull()?.timestampMillis ?: System.currentTimeMillis()
        if (Filter.looksLikeDeposit(text)) Sender.enqueue(ctx, text, ts)
    }
}
