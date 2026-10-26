"use strict";
/** @typedef {{key:string, factory:string, group:string, player?:boolean}} FeatureDefinition */
globalThis.__weAgoFeatures ||= Object.freeze([
  {key:"market",factory:"__weAgoMarket",group:"Market"},
  {key:"marketUndercut",factory:"__weAgoUndercut",group:"Market"},
  {key:"battle",factory:"__weAgoBattle",group:"Battle"},
  {key:"countryBuilds",factory:"__weAgoCountryBuilds",group:"Country & MU"},
  {key:"spyXray",factory:"__weAgoSpyXray",group:"Country & MU"},
  {key:"pillTimeline",factory:"__weAgoPillTimeline",group:"Country & MU"},
  {key:"companyAdvisor",factory:"__weAgoCompanyAdvisor",group:"Company",player:true},
  {key:"netSalary",factory:"__weAgoNetSalary",group:"Company"},
  {key:"bountyRadar",factory:"__weAgoBountyRadar",group:"Radar"},
  {key:"contractRadar",factory:"__weAgoContractRadar",group:"Radar"},
  {key:"lootRadar",factory:"__weAgoLootRadar",group:"Radar"},
  {key:"lootRoundTimer",factory:"__weAgoLootRoundTimer",group:"Radar"},
  {key:"equipmentCped",factory:"__weAgoEquipmentCped",group:"Market",player:true},
  {key:"fullBurst",factory:"__weAgoFullBurst",group:"Battle",player:true},
  {key:"pillRoi",factory:"__weAgoPillRoi",group:"Battle",player:true},
  {key:"passiveCache",factory:"__weAgoPassiveCacheModule",group:"Data"}
].map(Object.freeze));
