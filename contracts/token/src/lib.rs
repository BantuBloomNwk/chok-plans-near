//! A plain NEP-141 memecoin, built on NEAR's own fungible token standard. There is no minting after
//! the first second and no owner. `launch` is what the launcher calls: it mints the sale supply to
//! the market and the dev's share to the plan contract, then tells each of them, so a coin made this
//! way is bound to its plan from its first block.

use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_contract_standards::fungible_token::events::FtMint;
use near_sdk::serde_json::{json, Value};
use near_sdk::{near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Token,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Token {
    token: FungibleToken,
    name: String,
    symbol: String,
}

#[near]
impl Token {
    /// Mints the whole supply to `owner` once; nobody can mint again.
    #[init]
    pub fn new(owner: AccountId, total_supply: U128, name: String, symbol: String) -> Self {
        let mut token = FungibleToken::new(Key::Token);
        token.internal_register_account(&owner);
        token.internal_deposit(&owner, total_supply.0);
        FtMint { owner_id: &owner, amount: total_supply, memo: Some("the whole supply, once") }.emit();
        Self { token, name, symbol }
    }

    /// Made by the launcher in the same transaction that creates this account, which has no keys.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn launch(name: String, symbol: String, total_supply: U128, sale: U128, dev: AccountId, market: AccountId, plans: AccountId, terms: Value, plan_deposit: U128, pool_deposit: U128, launcher: AccountId) -> Self {
        let bag = total_supply.0 - sale.0;
        let mut token = FungibleToken::new(Key::Token);
        token.internal_register_account(&market);
        token.internal_register_account(&plans);
        // the dev has to be on the register to receive what the plan lets out
        token.internal_register_account(&dev);
        token.internal_deposit(&market, sale.0);
        token.internal_deposit(&plans, bag);
        FtMint { owner_id: &market, amount: sale, memo: Some("the sale supply") }.emit();
        FtMint { owner_id: &plans, amount: U128(bag), memo: Some("the dev's share, in its plan") }.emit();
        let _ = Promise::new(plans)
            .function_call("create_launched", json!({ "dev": dev, "terms": terms, "amount": U128(bag) }).to_string().into_bytes(), NearToken::from_yoctonear(plan_deposit.0), Gas::from_tgas(30))
            .then(Promise::new(market).function_call("list_launched", json!({ "creator": dev, "sale": sale }).to_string().into_bytes(), NearToken::from_yoctonear(pool_deposit.0), Gas::from_tgas(25)))
            .then(Promise::new(launcher).function_call("confirm", json!({}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(8)));
        Self { token, name, symbol }
    }
}

#[near]
impl FungibleTokenCore for Token {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }
    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }
    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Token {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Token {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Token {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}
