package kr.primebit.deposit

object Filter {
    /** 입금성 문구이고 출금/결제가 아닌 것만 전송 (최종 판단은 서버가 한 번 더 한다) */
    fun looksLikeDeposit(t: String): Boolean {
        val incoming = t.contains("입금") || t.contains("보냈어요")
        val outgoing = (t.contains("출금") || t.contains("결제") || t.contains("승인")) && !t.contains("입금")
        return incoming && !outgoing && t.contains("원")
    }
}
