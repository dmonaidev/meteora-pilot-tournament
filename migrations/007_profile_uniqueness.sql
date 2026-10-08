CREATE UNIQUE INDEX IF NOT EXISTS wallets_wallet_address_unique ON wallets(wallet_address);
CREATE UNIQUE INDEX IF NOT EXISTS partner_rewards_exchange_uid_unique ON partner_rewards(exchange_uid) WHERE exchange_uid IS NOT NULL;
