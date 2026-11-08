-- claim_items.seen：読みではなく、見えたこと（物の種類や見た目）が根拠のつながりなら 1。
-- 強さは clear と seen の合計で決める。読みが根拠のつながりは、今までどおり「はっきり」だけを数える。
ALTER TABLE claim_items ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;
