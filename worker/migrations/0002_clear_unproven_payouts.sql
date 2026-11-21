-- Clear all existing custom_payout_address values saved without EIP-191 proof-of-control.
CREATE TABLE IF NOT EXISTS payout_address_proofs (
  user_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  message TEXT NOT NULL,
  signature TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

UPDATE users
SET custom_payout_address = ''
WHERE custom_payout_address != ''
  AND LOWER(custom_payout_address) != LOWER(wallet_address)
  AND NOT EXISTS (
    SELECT 1
    FROM payout_address_proofs p
    WHERE p.user_id = users.id
      AND LOWER(p.address) = LOWER(users.custom_payout_address)
  );
