function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function findLiteralTerms(text, terms) {
  const normalized = normalizeText(text);
  const found = [];
  for (const term of terms || []) {
    const clean = String(term || '').trim();
    if (!clean) continue;
    const escaped = escapeRegExp(normalizeText(clean));
    const re = new RegExp('(^|[^a-z0-9_])' + escaped + '([^a-z0-9_]|$)', 'i');
    if (re.test(normalized) && !found.some(item => normalizeText(item) === normalizeText(clean))) {
      found.push(clean);
    }
  }
  return found;
}

function itemSearchText(item) {
  return [
    item && item.cliente,
    item && item.clientes,
    item && item.autor,
    item && item.autores,
    item && item.tipo,
    item && item.sigla,
    item && item.rotulo,
    item && item.titulo,
    item && item.identificacao,
    item && item.ementa,
    item && item.resumo,
    item && item.descricao,
    item && item.texto,
  ].filter(Boolean).join(' ');
}

function territoryStatus(rule, item, context) {
  if (rule.territory_type === 'BR_TODO') return 'br_todo';
  const uf = normalizeText((item && item.uf) || (context && context.uf));
  const municipio = normalizeText((item && (item.municipio || item.cidade)) || (context && context.municipio));
  const casa = normalizeText((item && (item.casa || item.house)) || (context && context.casa));
  const hasPlace = Boolean(uf || municipio || casa);
  if (uf && (rule.ufs || []).map(normalizeText).includes(uf)) return 'foco';
  if (municipio && (rule.cities || []).map(normalizeText).includes(municipio)) return 'foco';
  if (casa && (rule.houses || []).map(normalizeText).includes(casa)) return 'foco';
  return hasPlace ? 'fora' : 'desconhecido';
}

function defaultPhase0ClientRules() {
  const jaguareRule = {
    id: 'jaguare-incidente',
    base_terms: ['Jaguaré'],
    context_terms: ['explosão', 'explosao', 'vazamento', 'gás', 'gas', 'reparação', 'indenização', 'Defensoria', 'apuração', 'responsabilidade'],
    confidence: 'alta',
    reason: 'Jaguaré só acende com contexto material do acidente/risco operacional',
  };
  return [
    { id: 'firjan', official_name: 'FIRJAN', aliases: [], territory_type: 'PRACA_RESTRITA', ufs: ['RJ'], cities: ['Rio de Janeiro'], houses: ['ALERJ', 'CMRJ'], weak_keywords: ['indústria', 'industria'], monitor_priority: true },
    { id: 'boticario', official_name: 'Boticário', aliases: ['O Boticário', 'Boticario', 'O Boticario'], territory_type: 'BR_TODO', monitor_priority: true },
    { id: 'neoenergia', official_name: 'Neoenergia', aliases: ['Cosern'], territory_type: 'PRACA_RESTRITA', ufs: ['RN'], cities: ['Natal'] },
    { id: 'aegea', official_name: 'AEGEA', aliases: ['Águas do Rio', 'Águas de Teresina'], territory_type: 'PRACA_RESTRITA', ufs: ['RJ', 'PI'], cities: ['Rio de Janeiro', 'Teresina'] },
    { id: 'sabesp', official_name: 'SABESP', aliases: [], territory_type: 'PRACA_RESTRITA', ufs: ['SP'], cities: ['São Paulo'], special_rules: [jaguareRule] },
    { id: 'comgas', official_name: 'COMGÁS', aliases: ['Comgas'], territory_type: 'PRACA_RESTRITA', ufs: ['SP'], cities: ['São Paulo'], special_rules: [jaguareRule] },
  ];
}

function matchClientInterest(item, context = {}, rules = defaultPhase0ClientRules()) {
  const text = itemSearchText(item || {});
  const matches = [];
  for (const rule of rules) {
    if (findLiteralTerms(text, rule.negative_keywords || []).length) continue;
    const status = territoryStatus(rule, item || {}, context || {});
    const strongTerms = findLiteralTerms(text, [rule.official_name, ...(rule.aliases || []), ...(rule.strong_keywords || [])]);
    if (strongTerms.length) {
      matches.push({
        cliente: rule.official_name,
        cliente_id: rule.id,
        camada: ['foco', 'br_todo'].includes(status) ? '1/2' : '1',
        territorio_status: status,
        termos: strongTerms,
        confidence: 'alta',
        motivo: ['foco', 'br_todo'].includes(status) ? 'nome/alias forte em praça foco' : 'nome/alias forte literal; praça não condiciona o match',
      });
      continue;
    }
    let matchedSpecial = false;
    for (const special of rule.special_rules || []) {
      const baseTerms = findLiteralTerms(text, special.base_terms || []);
      const contextTerms = findLiteralTerms(text, special.context_terms || []);
      if (baseTerms.length && contextTerms.length) {
        matches.push({
          cliente: rule.official_name,
          cliente_id: rule.id,
          camada: 'especial',
          territorio_status: status,
          termos: [...new Set([...baseTerms, ...contextTerms])],
          confidence: special.confidence || 'alta',
          motivo: special.reason || 'regra material',
        });
        matchedSpecial = true;
        break;
      }
    }
    if (matchedSpecial) continue;
    const weakTerms = findLiteralTerms(text, rule.weak_keywords || []);
    if (weakTerms.length && ['foco', 'br_todo'].includes(status)) {
      matches.push({
        cliente: rule.official_name,
        cliente_id: rule.id,
        camada: '3',
        territorio_status: status,
        termos: weakTerms,
        confidence: 'media',
        motivo: 'keyword solta válida por território/contexto',
      });
    }
  }
  return matches.sort((a, b) => a.cliente.localeCompare(b.cliente, 'pt-BR'));
}

function appendUnique(values, additions) {
  const out = Array.isArray(values) ? values.slice() : [];
  const seen = new Set(out.map(normalizeText));
  for (const value of additions || []) {
    const clean = String(value || '').trim();
    const key = normalizeText(clean);
    if (clean && !seen.has(key)) {
      out.push(clean);
      seen.add(key);
    }
  }
  return out;
}

function promoverInteresseClienteProposicao(item, clientesAtuais = [], context = {}) {
  const atuais = Array.isArray(clientesAtuais) ? clientesAtuais : [];
  const matches = matchClientInterest(item || {}, context || {});
  if (item && typeof item === 'object') {
    item.clientInterestMatches = matches;
  }
  return appendUnique(atuais, matches.map(match => match.cliente));
}

module.exports = {
  defaultPhase0ClientRules,
  matchClientInterest,
  promoverInteresseClienteProposicao,
};
