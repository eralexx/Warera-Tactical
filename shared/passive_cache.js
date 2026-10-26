"use strict";
// Only public read results may cross the page/extension boundary. Never infer
// the saved account from the game's session or accept private inventory data.
globalThis.__weAgoPassiveCache = Object.freeze({
  channel: "we-ago-cache-warm-v1",
  procedures: Object.freeze([
    "itemTrading.getPrices", "tradingOrder.getTopOrders",
    "country.getAllCountries", "country.getCountryById",
    "region.getById", "region.getRegionsObject", "gameConfig.getGameConfig",
    "battle.getById", "battle.getLiveBattleData", "round.getById",
    "battle.getBattles", "battle.getDamageBonuses", "battleOrder.getByBattle", "battleRanking.getRanking",
    "company.getById", "company.getCompanies", "company.getProductionBonus", "upgrade.getUpgradeByTypeAndEntity",
    "gameStat.getEquipmentAvgByCode", "itemOffer.getItemOffers",
    "mu.getById", "user.getUsersByCountry", "user.getUserById", "user.getUserLite",
    "inventory.fetchCurrentEquipment", "mercenaryContract.getContracts", "mercenaryContract.getActiveForBattle",
    "mercenaryContractAuction.getPaginatedAuctions"
  ]),
  valid(record) {
    if (!record || !this.procedures.includes(record.procedure)
      || !record.input || typeof record.input !== "object" || Array.isArray(record.input)
      || record.data === undefined
      || !["official", "official5"].includes(record.provider)
      || !Number.isFinite(record.receivedAt)) return false;
    // Session-relative reads must never be attributed to the saved API account.
    if (["inventory.fetchCurrentEquipment", "user.getUserById", "user.getUserLite", "company.getCompanies"].includes(record.procedure)
      && !/^[a-f\d]{24}$/i.test(record.input.userId || "")) return false;
    if (["user.getUserById", "user.getUserLite"].includes(record.procedure)
      && record.data?._id !== record.input.userId) return false;
    try {
      // Bound bridge and storage work; reject sensitive or prototype keys even
      // in an otherwise public response. Page messages are untrusted input.
      const text = JSON.stringify(record);
      return text.length <= 250000 && JSON.stringify(record.input).length <= 4000
        && !/"(?:__proto__|prototype|constructor|authorization|token|accessToken|refreshToken|password|email|cookie)"\s*:/i.test(text);
    } catch { return false; }
  }
});
