'use strict';

// Flavia DM46368, 13/11/2026: sinalização nacional, independente de praça,
// espécie legislativa e cadastro prévio. Não associa nem notifica clientes.
const PRIORITY_TERMS = [
  { label: 'bebidas', pattern: /(^|[^a-z0-9_])bebidas?(?=[^a-z0-9_]|$)/i },
  { label: 'cerveja', pattern: /(^|[^a-z0-9_])cervejas?(?=[^a-z0-9_]|$)/i },
  { label: 'logística reversa', pattern: /(^|[^a-z0-9_])logistica[\s\u00a0-]+reversa(?=[^a-z0-9_]|$)/i },
];
// Mesma carteira ativa do matcher publicado; não reativa nomes históricos.
const COMPANY_NAMES = [
  'FIRJAN', 'Red Bull', 'RedBull', 'Sindicerv', 'Boticário', 'Grupo Boticário',
  'O Boticário', 'oBoticario', 'JBS', 'Friboi', 'MindLab', 'Mind Lab', '4UM', '4UM/Opportunity',
  'Abrasel PB', 'Abrasel | PB', 'Abrasel Paraíba', 'Consórcio Maracanã', 'Octavio Dyckerhoff',
];
function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function prioritySignals(item = {}) {
  // Só texto da matéria; vínculos no cadastro não são citação nominal.
  const text = normalize(['ementa','titulo','identificacao','resumo','descricao','texto']
    .map(key => String(item[key] || '').split(/\s+\|\s+(?:🆘\s*)?CLIENTE CITADO:/i)[0]).join(' '));
  const terms = PRIORITY_TERMS.filter(rule => rule.pattern.test(text)).map(rule => rule.label);
  const companies = COMPANY_NAMES.filter(name => new RegExp('(^|[^a-z0-9_])' + escapeRegExp(normalize(name)) + '(?=[^a-z0-9_]|$)', 'i').test(text));
  return { terms, companies };
}
function priorityEmenta(html, item) {
  if (String(html).includes('data-props-priority="1"')) return html;
  const { terms, companies } = prioritySignals(item);
  const labels = [];
  if (terms.length) labels.push('🆘 TERMO PRIORITÁRIO: ' + terms.join(', '));
  // Preserva o destaque nominal existente sem repetir o mesmo marcador.
  if (companies.length && !/CLIENTE CITADO|EMPRESA CITADA/i.test(html)) labels.push('🆘 EMPRESA CITADA: ' + companies.join(', '));
  if (!labels.length) return html;
  return html + '<div data-props-priority="1" style="margin-top:6px;background:#fff1f2;border:1px solid #fb7185;color:#991b1b;border-radius:5px;padding:6px 9px;font-weight:800;font-size:12px">' +
    labels.map(escapeHtml).join('<br>') + '</div>';
}
function prioritySubject(items, original) {
  const signals = (items || []).map(prioritySignals);
  const terms = [...new Set(signals.flatMap(s => s.terms))];
  if (terms.length) return '🆘 Termo prioritário: ' + terms.join(', ') + ' | ' + original;
  const companies = [...new Set(signals.flatMap(s => s.companies))];
  if (companies.length && !/Cliente citado|Empresa citada/i.test(original)) return '🆘 Empresa citada: ' + companies.slice(0, 3).join(', ') + ' | ' + original;
  return original;
}
function isActiveCompany(name) {
  return COMPANY_NAMES.some(active => normalize(active) === normalize(name));
}
module.exports = { prioritySignals, priorityEmenta, prioritySubject, escapeHtml, COMPANY_NAMES, isActiveCompany };
