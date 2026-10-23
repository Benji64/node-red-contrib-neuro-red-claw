/**
 * Première couverture de security-policy.js — niveau 1 de la sécurité
 * (Technical Security : patterns dangereux, rate limits, allow/deny).
 * Jusqu'ici aucune preuve d'aucune sorte que ce composant fait ce qu'il dit.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const SecurityPolicy = require("../../lib/security-policy");

function policy(cfg) {
  const p = new SecurityPolicy(cfg);
  test.after(() => p.destroy());
  return p;
}

test("le timer de nettoyage ne garde pas le processus vivant (régression)", () => {
  // Sans .unref(), un `new SecurityPolicy()` jamais détruit empêche le
  // processus de se terminer — bloque tout usage hors cycle de vie Node-RED.
  const lib = path.join(__dirname, "..", "..", "lib", "security-policy.js");
  const r = spawnSync(process.execPath, ["-e", `new (require(${JSON.stringify(lib)}))()`], { timeout: 4000 });
  assert.equal(r.error?.code, undefined, "le processus ne doit pas rester bloqué (timeout)");
  assert.equal(r.status, 0);
});

test("défaut allow historique : un tool sans règle exige une revue humaine", () => {
  const r = policy().evaluate("turn_on", { device: "salon" }, "s1");
  assert.equal(r.allowed, true);
  assert.equal(r.action, "confirm");
  assert.equal(r.requireConfirm, true);
  assert.deepEqual(r.riskCategories, ["technical", "policy", "privacy", "external"]);
});

test("défaut deny : un tool sans règle est refusé, un tool avec règle allow passe", () => {
  const p = policy({ defaultAction: "deny", rules: [{ tool: "turn_on", action: "allow" }] });
  assert.equal(p.evaluate("turn_on", {}, "s1").allowed, true);
  const r = p.evaluate("delete_all", {}, "s1");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /deny par défaut/);
});

test("défaut deny ne transforme pas une règle de contrainte en autorisation implicite", () => {
  const p = policy({
    defaultAction: "deny",
    rules: [
      { tool: "limited", rateLimit: { maxCalls: 5, windowMs: 60000 } },
      { tool: "validated", paramRules: { id: { required: true } } },
    ],
  });

  for (const tool of ["limited", "validated"]) {
    const result = p.evaluate(tool, { id: "ok" }, "s");
    assert.equal(result.allowed, false, `${tool} doit rester refusé sans action allow explicite`);
    assert.match(result.reason, /deny par défaut/);
  }
});

test("une configuration de règles malformée échoue de manière restrictive", () => {
  const sparseRules = new Array(1);
  const sparseCategories = new Array(1);
  const sparseAllowedValues = new Array(1);
  for (const config of [
    { rules: {} },
    { rules: [null] },
    { rules: sparseRules },
    { rules: [{ tool: "x", action: "execute" }] },
    { rules: [{ tool: "x", reason: { message: "invalid" } }] },
    { rules: [{ tool: "" }] },
    { rules: [{ tool: "x", riskCategories: sparseCategories }] },
    { rules: [{ tool: "x", rateLimit: { maxCalls: -1, windowMs: 60000 } }] },
    { rules: [{ tool: "x", paramRules: [] }] },
    { rules: [{ tool: "x", paramRules: { room: { allowedValues: [{ room: "hall" }] } } }] },
    { rules: [{ tool: "x", paramRules: { room: { allowedValues: sparseAllowedValues } } }] },
    { rules: [{ tool: "x", paramRules: { room: { type: "number", allowedValues: ["1"] } } }] },
    { defaultAction: "invalid" },
  ]) {
    const p = policy(config);
    const result = p.evaluate("unrelated-tool", {}, "s");
    assert.equal(p.configurationValid, false);
    assert.equal(result.allowed, false);
    assert.equal(result.action, "deny");
    assert.match(result.reason, /Configuration de sécurité invalide/);
  }
});

test("une configuration de politique qui n'est pas un objet échoue de manière restrictive", () => {
  for (const config of [null, [], "allow", 42, false]) {
    const result = policy(config).evaluate("run", {}, "s");
    assert.equal(result.allowed, false);
    assert.equal(result.action, "deny");
    assert.match(result.reason, /Configuration de sécurité invalide/);
  }
});

test("les options d'évaluation invalides sont refusées sans exception", () => {
  const p = policy({ rules: [{ tool: "*", action: "allow" }] });
  for (const options of [null, [], false, "skip", { skipRateLimit: "true" }, { approvalGranted: 1 }]) {
    const result = p.evaluate("run", {}, "s", options);
    assert.equal(result.allowed, false);
    assert.equal(result.action, "deny");
    assert.match(result.reason, /Options de sécurité invalides/);
  }

  assert.equal(p.evaluate("run", {}, "s", { skipRateLimit: true, approvalGranted: false }).allowed, true);
});

test("les flags de privilège hérités ne contournent ni confirmation ni rate limit", () => {
  const approvalPolicy = policy({
    rules: [{ tool: "sensitive", action: "confirm" }],
  });
  const inheritedApproval = Object.create({ approvalGranted: true });
  const approval = approvalPolicy.evaluate("sensitive", {}, "s", inheritedApproval);
  assert.equal(approval.allowed, true);
  assert.equal(approval.requireConfirm, true);

  const limitedPolicy = policy({
    rules: [{
      tool: "limited",
      action: "allow",
      riskCategories: ["technical"],
      impact: "low",
      rateLimit: { maxCalls: 1, windowMs: 60000 },
    }],
  });
  assert.equal(limitedPolicy.evaluate("limited", {}, "s").allowed, true);
  const inheritedSkip = Object.create({ skipRateLimit: true });
  const limited = limitedPolicy.evaluate("limited", {}, "s", inheritedSkip);
  assert.equal(limited.allowed, false);
  assert.match(limited.reason, /Rate limit/);
});

test("règle deny : refus avec la raison fournie", () => {
  const p = policy({ rules: [{ tool: "shutdown", action: "deny", reason: "interdit en prod" }] });
  const r = p.evaluate("shutdown", {}, "s1");
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "interdit en prod");
});

test("règle confirm : autorisé MAIS requireConfirm", () => {
  const p = policy({ rules: [{ tool: "open_door", action: "confirm", reason: "porte" }] });
  const r = p.evaluate("open_door", {}, "s1");
  assert.equal(r.allowed, true);
  assert.equal(r.requireConfirm, true);
});

test("défaut deny exige une action allow explicite même si une règle demande confirmation", () => {
  const confirmOnly = policy({
    defaultAction: "deny",
    rules: [{ tool: "open_door", action: "confirm" }],
  });
  const confirmationWithAllow = policy({
    defaultAction: "deny",
    rules: [
      { tool: "*", action: "allow" },
      { tool: "open_door", action: "confirm" },
    ],
  });

  const denied = confirmOnly.evaluate("open_door", {}, "s");
  assert.equal(denied.allowed, false);
  assert.equal(denied.requireConfirm, false);
  assert.match(denied.reason, /deny par défaut/);

  const confirmed = confirmationWithAllow.evaluate("open_door", {}, "s");
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.requireConfirm, true);
});

test("une règle deny correspondante prime toujours une règle confirm, quel que soit l'ordre", () => {
  const confirmFirst = policy({
    rules: [
      { tool: "*", action: "confirm", reason: "confirmation générale" },
      { tool: "delete_user", action: "deny", reason: "suppression interdite" },
    ],
  });
  const denyFirst = policy({
    rules: [
      { tool: "delete_user", action: "deny", reason: "suppression interdite" },
      { tool: "*", action: "confirm", reason: "confirmation générale" },
    ],
  });

  for (const result of [
    confirmFirst.evaluate("delete_user", {}, "s"),
    denyFirst.evaluate("delete_user", {}, "s"),
  ]) {
    assert.equal(result.allowed, false);
    assert.equal(result.requireConfirm, false);
    assert.equal(result.reason, "suppression interdite");
  }
});

test("les règles sont isolées de la configuration et des résultats d'évaluation", () => {
  const rule = {
    tool: "open_door",
    action: "deny",
    paramRules: { room: { allowedValues: ["hall"] } },
  };
  const config = { rules: [rule] };
  const p = policy(config);

  rule.action = "allow";
  rule.paramRules.room.allowedValues.push("bedroom");
  config.rules.push({ tool: "*", action: "allow" });
  p.rules = [{ tool: "*", action: "allow" }];

  const denied = p.evaluate("open_door", { room: "hall" }, "s1");
  assert.equal(denied.allowed, false);
  denied.rule.action = "allow";
  denied.rule.paramRules.room.allowedValues.push("bedroom");
  assert.equal(p.evaluate("open_door", { room: "bedroom" }, "s1").allowed, false);
  assert.equal(p.evaluate("open_door", { room: "hall" }, "s1").allowed, false);

  const confirmPolicy = policy({
    rules: [{ tool: "secure", action: "confirm", paramRules: { enabled: { type: "boolean" } } }],
  });
  const confirmation = confirmPolicy.evaluate("secure", { enabled: true }, "s1");
  confirmation.rule.action = "allow";
  assert.equal(confirmPolicy.evaluate("secure", { enabled: true }, "s2").requireConfirm, true);
});

test("jokers glob : '*', préfixe, suffixe et caractères littéraux", () => {
  const p = policy({
    rules: [
      { tool: "*write*", action: "confirm" },
      { tool: "delete_*", action: "deny" },
      { tool: "read.file", action: "deny" },
      { tool: "*", action: "allow" },
    ],
  });
  assert.equal(p.evaluate("write_file", {}, "s").requireConfirm, true);
  assert.equal(p.evaluate("file_write", {}, "s").requireConfirm, true);
  assert.equal(p.evaluate("delete_file", {}, "s").allowed, false);
  assert.equal(p.evaluate("readXfile", {}, "s").allowed, true);
  assert.equal(p.evaluate("read.file", {}, "s").allowed, false);
  assert.equal(p.evaluate("other", {}, "s").allowed, true);
});

test("les motifs contenant plusieurs jokers sont évalués séquentiellement", () => {
  const p = policy({ rules: [{ tool: "*a*a*a*b", action: "deny" }] });
  assert.equal(p.evaluate("aaaaaaaaaaaaaaaaaaaab", {}, "s").allowed, false);
  assert.equal(p.evaluate("aaaaaaaaaaaaaaaaaaaa", {}, "s").allowed, true);
});

test("patterns dangereux refusés quelle que soit la règle", () => {
  const p = policy({ rules: [{ tool: "*", action: "allow" }] });
  for (const bad of ["../secret", "..\\secret", "a; ls", "rm -rf /", "DROP TABLE users", "/etc/passwd", "eval(x)", "`id`", "$(id)"]) {
    const r = p.evaluate("run", { cmd: bad }, "s");
    assert.equal(r.allowed, false, `doit refuser: ${bad}`);
  }
});

test("le scan de sécurité inspecte les valeurs brutes malgré un toJSON trompeur", () => {
  const params = { cmd: "rm -rf /" };
  Object.defineProperty(params, "toJSON", {
    value() { return { cmd: "safe" }; },
  });
  const result = policy().evaluate("run", params, "s");

  assert.equal(result.allowed, false);
  assert.match(result.reason, /Paramètre dangereux/);
});

test("le scan refuse une méthode toJSON héritée qui pourrait transformer les paramètres", () => {
  const params = Object.create({
    toJSON() { return { cmd: "rm -rf /" }; },
  });
  params.cmd = "safe";

  const result = policy().evaluate("run", params, "s");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /paramètres non sérialisables/);
});

test("le scan refuse les paramètres avec des propriétés héritées hors JSON", () => {
  const params = Object.create({ cmd: "rm -rf /" });
  params.label = "safe";

  const result = policy().evaluate("run", params, "s");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /paramètres non sérialisables/);
});

test("le scan refuse les propriétés non énumérables et symboliques non JSON", () => {
  const hidden = { label: "safe" };
  Object.defineProperty(hidden, "cmd", { value: "rm -rf /" });
  const symbolic = { label: "safe", [Symbol("cmd")]: "rm -rf /" };
  const arrayWithExtraProperty = Object.assign(["safe"], { cmd: "rm -rf /" });
  const sparseArray = [];
  sparseArray.length = 1;

  for (const params of [
    hidden,
    symbolic,
    { value: arrayWithExtraProperty },
    { value: sparseArray },
    { value: NaN },
    { value: Infinity },
    { value: -Infinity },
  ]) {
    const result = policy().evaluate("run", params, "s");
    assert.equal(result.allowed, false);
    assert.match(result.reason, /paramètres non sérialisables/);
  }
});

test("paramètres bénins autorisés", () => {
  const r = policy().evaluate("set_temp", { room: "salon", value: 21 }, "s");
  assert.equal(r.allowed, true);
});

test("comportement conservateur DOCUMENTÉ : parenthèses et & refusés même dans du texte légitime", () => {
  // Choix de conception assumé (précision sacrifiée à la prudence), rendu
  // explicite ici pour qu'une future modification soit une décision visible.
  const p = policy();
  assert.equal(p.evaluate("say", { text: "salon (RDC)" }, "s").allowed, false);
  assert.equal(p.evaluate("say", { text: "Paulette & Marc" }, "s").allowed, false);
});

test("rate limit par tool : N appels passent, le suivant est refusé, par session", () => {
  const p = policy({ rules: [{ tool: "ping", action: "allow", rateLimit: { maxCalls: 2, windowMs: 60000 } }] });
  assert.equal(p.evaluate("ping", {}, "A").allowed, true);
  assert.equal(p.evaluate("ping", {}, "A").allowed, true);
  assert.equal(p.evaluate("ping", {}, "A").allowed, false);
  assert.equal(p.evaluate("ping", {}, "B").allowed, true, "une autre session a son propre quota");
});

test("les rate limits de règles distinctes gardent des compteurs indépendants", () => {
  const p = policy({
    rules: [
      { tool: "*", action: "allow", rateLimit: { maxCalls: 3, windowMs: 60000 } },
      { tool: "ping", action: "allow", rateLimit: { maxCalls: 2, windowMs: 60000 } },
    ],
  });

  assert.equal(p.evaluate("ping", {}, "S").allowed, true);
  assert.equal(p.evaluate("ping", {}, "S").allowed, true);
  assert.equal(p.evaluate("ping", {}, "S").allowed, false, "le quota le plus strict bloque au troisième appel");
  assert.equal(p.evaluate("other", {}, "S").allowed, true, "la limite ping ne doit pas bloquer un autre tool");
});

test("les identifiants contenant des séparateurs ne font pas collisionner les compteurs", () => {
  const p = policy({
    rules: [{ tool: "*", action: "allow", rateLimit: { maxCalls: 1, windowMs: 60000 } }],
  });

  assert.equal(p.evaluate("c", {}, "a:b").allowed, true);
  assert.equal(p.evaluate("b:c", {}, "a").allowed, true);
  assert.equal(p.evaluate("c", {}, "a:b").allowed, false);
  assert.equal(p.evaluate("b:c", {}, "a").allowed, false);
});

test("une règle confirm ne court-circuite pas les limites des autres règles correspondantes", () => {
  const p = policy({
    rules: [
      { tool: "*", action: "confirm", reason: "confirmation générale" },
      { tool: "delete_user", action: "allow", rateLimit: { maxCalls: 1, windowMs: 60000 } },
    ],
  });

  assert.equal(p.evaluate("delete_user", {}, "S").requireConfirm, true);
  const second = p.evaluate("delete_user", {}, "S");
  assert.equal(second.allowed, false);
  assert.match(second.reason, /Rate limit/);
});

test("rate limit global par session", () => {
  const p = policy({ globalRateLimit: { maxCalls: 1, windowMs: 60000 } });
  assert.equal(p.evaluate("a", {}, "S").allowed, true);
  const r = p.evaluate("b", {}, "S");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Rate limit global/);
});

test("le nettoyage conserve les compteurs jusqu'à la fin de leur fenêtre configurée", () => {
  const p = policy({ globalRateLimit: { maxCalls: 1, windowMs: 2 * 60 * 60 * 1000 } });
  const originalNow = Date.now;
  let now = originalNow();

  try {
    Date.now = () => now;
    assert.equal(p.evaluate("a", {}, "S").allowed, true);

    now += 60 * 60 * 1000 + 1;
    p._cleanRates();

    const result = p.evaluate("b", {}, "S");
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Rate limit global/);
  } finally {
    Date.now = originalNow;
  }
});

test("les limites de débit explicites invalides refusent l'appel", () => {
  for (const maxCalls of ["NaN", 10001]) {
    const global = policy({ globalRateLimit: { maxCalls, windowMs: 60000 } });
    const globalResult = global.evaluate("unrelated", {}, "S");
    assert.equal(global.configurationValid, false);
    assert.equal(globalResult.allowed, false);
    assert.match(globalResult.reason, /Configuration de sécurité invalide/);
  }

  for (const rateLimit of [
    { maxCalls: 2, windowMs: 0 },
    { maxCalls: 10001, windowMs: 60000 },
  ]) {
    const local = policy({ rules: [{ tool: "ping", action: "allow", rateLimit }] });
    assert.equal(local.configurationValid, false);
    assert.match(local.evaluate("unrelated", {}, "S").reason, /Configuration de sécurité invalide/);
  }
});

test("une limite globale explicitement mal typée n'est pas traitée comme désactivée", () => {
  for (const globalRateLimit of [false, 0, ""]) {
    const result = policy({ globalRateLimit }).evaluate("run", {}, "s");
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Configuration de sécurité invalide/);
  }

  assert.equal(policy({ globalRateLimit: null }).evaluate("run", {}, "s").allowed, true);
});

test("les contraintes explicitement nulles ou mal typées ne sont pas ignorées", () => {
  for (const rule of [
    { tool: "x", action: "allow", paramRules: null },
    { tool: "x", action: "allow", paramRules: false },
    { tool: "x", action: "allow", rateLimit: null },
    { tool: "x", action: "allow", rateLimit: [] },
  ]) {
    assert.equal(policy({ rules: [rule] }).evaluate("x", {}, "s").allowed, false);
  }
});

test("les noms d'outil doivent être des chaînes non vides", () => {
  const p = policy({ rules: [{ tool: "*", action: "allow" }] });
  for (const toolName of [undefined, null, 0, {}, ""]) {
    const result = p.evaluate(toolName, {}, "s");
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Nom d'outil invalide/);
  }
});

test("les paramètres de tool doivent être un objet avant de consommer le quota", () => {
  const p = policy({
    globalRateLimit: { maxCalls: 1, windowMs: 60000 },
    rules: [{ tool: "*", action: "allow" }],
  });

  for (const params of [undefined, null, false, 0, "", []]) {
    const result = p.evaluate("run", params, "s");
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Paramètres d'outil invalides/);
  }

  assert.equal(p.evaluate("run", {}, "s").allowed, true, "un appel invalide ne doit pas consommer le quota");
});

test("les identifiants de session doivent être des chaînes non vides", () => {
  const p = policy({ globalRateLimit: { maxCalls: 1, windowMs: 60000 } });
  for (const sessionId of [undefined, null, 0, {}, "", 1n]) {
    const result = p.evaluate("run", {}, sessionId);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Identifiant de session invalide/);
  }
  assert.equal(p.evaluate("run", {}, "valid").allowed, true);
});

test("un appel refusé ne consomme pas de quota de rate limit", () => {
  const p = policy({ rules: [{ tool: "x", action: "allow", rateLimit: { maxCalls: 1, windowMs: 60000 } }] });
  assert.equal(p.evaluate("x", {}, "S").allowed, true);
  assert.equal(p.evaluate("x", {}, "S").allowed, false);
  assert.equal(p.evaluate("x", {}, "S").allowed, false);
  const key = JSON.stringify(["rule", 0, "S", "x"]);
  assert.equal(p._rates.get(key).timestamps.length, 1, "les refus ne doivent pas allonger la liste");
});

test("les appels refusés par validation ou deny ne consomment aucun quota", () => {
  const p = policy({
    globalRateLimit: { maxCalls: 1, windowMs: 60000 },
    rules: [
      { tool: "validated", action: "allow", rateLimit: { maxCalls: 1, windowMs: 60000 },
        paramRules: { id: { required: true } } },
      { tool: "blocked", action: "deny" },
    ],
  });

  assert.equal(p.evaluate("validated", {}, "S").allowed, false);
  assert.equal(p.evaluate("blocked", {}, "S").allowed, false);
  assert.equal(p._rates.size, 0, "aucun refus ne doit enregistrer de quota global ou local");

  assert.equal(p.evaluate("validated", { id: "ok" }, "S").allowed, true);
  const globalKey = JSON.stringify(["global", "S"]);
  const localKey = JSON.stringify(["rule", 0, "S", "validated"]);
  assert.equal(p._rates.get(globalKey).timestamps.length, 1);
  assert.equal(p._rates.get(localKey).timestamps.length, 1);
});

test("le nombre de buckets rate limit est borné sans bloquer les buckets existants", () => {
  const p = policy({ globalRateLimit: { maxCalls: 2, windowMs: 60000 } });
  const now = Date.now();
  for (let index = 0; index < 10000; index++) {
    p._rates.set(JSON.stringify(["global", `session-${index}`]), {
      timestamps: [now],
      windowMs: 60000,
    });
  }
  p._rateTimestampCount = 10000;

  assert.equal(p.evaluate("run", {}, "session-0").allowed, true);
  const result = p.evaluate("run", {}, "new-session");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Capacité maximale des rate limits/);
  assert.equal(p._rates.size, 10000);
});

test("le budget global des timestamps rate limit bloque et se libère après expiration", () => {
  const p = policy({ globalRateLimit: { maxCalls: 11, windowMs: 60000 } });
  const now = Date.now();
  for (let bucket = 0; bucket < 10000; bucket++) {
    p._rates.set(JSON.stringify(["global", `session-${bucket}`]), {
      timestamps: Array(10).fill(now),
      windowMs: 60000,
    });
  }
  p._rateTimestampCount = 100000;

  const full = p.evaluate("run", {}, "new-session");
  assert.equal(full.allowed, false);
  assert.match(full.reason, /Capacité maximale des rate limits/);
  assert.equal(p._rates.size, 10000);
  assert.equal(p._rateTimestampCount, 100000);

  for (const entry of p._rates.values()) {
    entry.timestamps = entry.timestamps.map(() => now - 60001);
  }
  p._cleanRates();
  assert.equal(p._rateTimestampCount, 0);
  assert.equal(p.evaluate("run", {}, "new-session").allowed, true);
  assert.equal(p._rateTimestampCount, 1);
});

test("paramRules : required, type, maxLength, allowedValues", () => {
  const p = policy({ rules: [{ tool: "t", action: "allow", paramRules: {
    room:  { required: true, type: "string", maxLength: 5, allowedValues: ["salon", "cuis"] },
  }}]});
  assert.equal(p.evaluate("t", { room: "salon" }, "s").allowed, true);
  assert.equal(p.evaluate("t", {}, "s").allowed, false, "requis");
  assert.equal(p.evaluate("t", { room: 3 }, "s").allowed, false, "type");
  assert.equal(p.evaluate("t", { room: "garage" }, "s").allowed, false, "valeur/longueur");
});

test("paramRules.required accepte false et zéro, et refuse seulement les valeurs absentes", () => {
  const p = policy({
    rules: [{ tool: "set", action: "allow", paramRules: {
      enabled: { required: true, type: "boolean" },
      level: { required: true, type: "number" },
    } }],
  });
  assert.equal(p.evaluate("set", { enabled: false, level: 0 }, "s").allowed, true);
  assert.equal(p.evaluate("set", { enabled: false }, "s").allowed, false);
});

test("paramRules.required ignore les propriétés héritées du prototype", () => {
  const p = policy({
    rules: [{ tool: "set", action: "allow", paramRules: {
      constructor: { required: true },
      toString: { required: true },
    } }],
  });

  const result = p.evaluate("set", {}, "s");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /constructor.*requis/);
});

test("paramRules refuse les options required et type mal typées", () => {
  for (const paramRule of [
    { required: "false" },
    { required: 0 },
    { type: "" },
    { type: "text" },
  ]) {
    const result = policy({
      rules: [{ tool: "set", action: "allow", paramRules: { value: paramRule } }],
    }).evaluate("set", { value: "anything" }, "s");

    assert.equal(result.allowed, false);
    assert.match(result.reason, /Configuration de sécurité invalide/);
  }
});

test("paramRules.type distingue les objets, tableaux et nombres finis", () => {
  const objectPolicy = policy({
    rules: [{ tool: "set", action: "allow", paramRules: { value: { type: "object" } } }],
  });
  for (const value of [null, [], "text"]) {
    assert.equal(objectPolicy.evaluate("set", { value }, "s").allowed, false);
  }
  assert.equal(objectPolicy.evaluate("set", { value: { nested: true } }, "s").allowed, true);

  const numberPolicy = policy({
    rules: [{ tool: "set", action: "allow", paramRules: { value: { type: "number" } } }],
  });
  for (const value of [undefined, NaN, Infinity, -Infinity, "1"]) {
    assert.equal(numberPolicy.evaluate("set", { value }, "s").allowed, false);
  }
  assert.equal(numberPolicy.evaluate("set", { value: 0 }, "s").allowed, true);
});

test("paramRules.maxLength exige une chaîne lorsqu'une valeur est fournie", () => {
  const p = policy({
    rules: [{ tool: "set", action: "allow", paramRules: { value: { maxLength: 3 } } }],
  });

  assert.equal(p.evaluate("set", {}, "s").allowed, true, "un champ optionnel absent reste valide");
  assert.equal(p.evaluate("set", { value: "abc" }, "s").allowed, true);
  assert.equal(p.evaluate("set", { value: "long" }, "s").allowed, false);
  for (const value of [0, false, {}, []]) {
    assert.equal(p.evaluate("set", { value }, "s").allowed, false);
  }
  assert.equal(p.evaluate("set", { value: undefined }, "s").allowed, false);
});

test("paramRules refuse maxLength utilisé avec un type incompatible", () => {
  const result = policy({
    rules: [{ tool: "set", action: "allow", paramRules: { value: { type: "number", maxLength: 3 } } }],
  }).evaluate("set", { value: 1 }, "s");

  assert.equal(result.allowed, false);
  assert.match(result.reason, /Configuration de sécurité invalide/);
});

test("paramRules.allowedValues exige une liste non vide et une valeur présente", () => {
  const p = policy({
    rules: [{ tool: "set", action: "allow", paramRules: { value: { allowedValues: ["on", "off"] } } }],
  });
  assert.equal(p.evaluate("set", { value: "on" }, "s").allowed, true);
  assert.equal(p.evaluate("set", {}, "s").allowed, false);
  assert.equal(p.evaluate("set", { value: undefined }, "s").allowed, false);

  for (const allowedValues of [[], "on", null]) {
    const result = policy({
      rules: [{ tool: "set", action: "allow", paramRules: { value: { allowedValues } } }],
    }).evaluate("set", { value: "on" }, "s");
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Configuration de sécurité invalide/);
  }
});

test("un payload non sérialisable est refusé explicitement", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const result = policy().evaluate("run", cyclic, "s");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /non sérialisables/);
});
