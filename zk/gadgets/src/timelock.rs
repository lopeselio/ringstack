//! The program's half of a timelock.
//!
//! A time is not checked in a circuit: a proof has no clock. The pattern,
//! from upstream's timelock escrow, has two halves:
//!
//! 1. **Circuit:** the time is a term committed in the UTXO's data. The
//!    circuit asserts the public input equals the committed term, with a named
//!    rule: `public.unlock.assert_equal(&terms.unlock, RULE)`. Without that
//!    line the prover can pass any time it likes.
//! 2. **Program:** the program passes the same value as the public input and
//!    checks it against `Clock::get()?.unix_timestamp` with the functions
//!    below. Without that check the circuit binds a time nobody enforces.
//!
//! These functions take the clock's `i64` as is. A negative clock is never
//! after an unlock time.

/// Whether `now` is strictly after `unlock`: a release or refund that opens at
/// `unlock` is allowed. The same comparison as upstream's timelock escrow.
pub const fn is_unlocked(now: i64, unlock: u64) -> bool {
    now >= 0 && (now as u64) > unlock
}

/// Whether `now` is strictly before `deadline`: an action that closes at
/// `deadline` is still allowed. Exactly one of `is_unlocked(now, t)` and
/// `is_before(now, t + 1)` holds for every `now` and `t < u64::MAX`.
pub const fn is_before(now: i64, deadline: u64) -> bool {
    now < 0 || (now as u64) < deadline
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlock_is_strict_and_negative_clocks_never_unlock() {
        assert!(!is_unlocked(100, 100));
        assert!(is_unlocked(101, 100));
        assert!(!is_unlocked(-1, 0));
        assert!(!is_unlocked(i64::MIN, 0));
        assert!(is_unlocked(i64::MAX, (i64::MAX - 1) as u64));
        assert!(!is_unlocked(i64::MAX, u64::MAX));
    }

    #[test]
    fn before_is_strict() {
        assert!(is_before(99, 100));
        assert!(!is_before(100, 100));
        assert!(is_before(-5, 0));
        assert!(!is_before(0, 0));
    }

    #[test]
    fn unlocked_and_before_split_time_at_one_point() {
        for t in [0u64, 1, 100, (i64::MAX - 1) as u64] {
            for now in [i64::MIN, -1, 0, 1, 99, 100, 101, i64::MAX] {
                assert_ne!(
                    is_unlocked(now, t),
                    is_before(now, t + 1),
                    "now {now}, t {t}"
                );
            }
        }
    }
}
