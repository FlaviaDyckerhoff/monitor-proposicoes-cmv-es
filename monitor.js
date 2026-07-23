const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br';
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE || 'flavia@monitorlegislativo.com.br';
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'ES - Vitória';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';

const URL_BASE = 'https://camarasempapel.cmv.es.gov.br/spl/consulta-producao.aspx';
const URL_ORIGEM = 'https://camarasempapel.cmv.es.gov.br/spl/';
const ANO = new Date().getFullYear();
const ITENS_POR_PAGINA = 50;
const MAX_PAGINAS_PRIMEIRO_RUN = 10; // 500 proposições no backlog inicial

// Tipos monitorados — filtro aplicado após coleta
const TIPOS_MONITORADOS = [
  'projeto de lei',
  'projeto de lei complementar',
  'projeto de lei iniciativa popular',
  'projeto de decreto legislativo',
  'projeto de resolução',
  'proposta de emenda à lei orgânica',
  'requerimento de informação',
  'mensagem',
  'p. de indicação',
  'indicação',
  'veto',
  'audiência pública - externa',
  'audiência pública-interno',
  'audiência pública - interno',
];

function tipoMonitorado(tipo) {
  if (!tipo) return false;
  const t = tipo.toLowerCase().trim();
  return TIPOS_MONITORADOS.some(m => t.includes(m) || m.includes(t));
}

// ─── Estado ──────────────────────────────────────────────────────────────────

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function extrairViewState(html) {
  const m = html.match(/id="__VIEWSTATE"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

function extrairViewStateGenerator(html) {
  const m = html.match(/id="__VIEWSTATEGENERATOR"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

function extrairEventValidation(html) {
  const m = html.match(/id="__EVENTVALIDATION"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

function extrairDoCampoUpdatePanel(resposta, nomeCampo) {
  const partes = resposta.split('|');
  for (let i = 0; i < partes.length - 3; i++) {
    if (partes[i + 1] === 'hiddenField' && partes[i + 2] === nomeCampo) {
      return partes[i + 3];
    }
  }
  return null;
}

function extrairViewStateDeResposta(resposta) {
  return extrairDoCampoUpdatePanel(resposta, '__VIEWSTATE');
}

function extrairEventValidationDeResposta(resposta) {
  return extrairDoCampoUpdatePanel(resposta, '__EVENTVALIDATION');
}

function extrairHtmlUpdatePanel(resposta) {
  const marker = '|updatePanel|ContentPlaceHolder1_upp_consultaProducao|';
  const idx = resposta.indexOf(marker);
  if (idx === -1) return null;
  const inicio = idx + marker.length;
  const tamanhoStr = resposta.substring(0, idx).split('|').pop();
  const tamanho = parseInt(tamanhoStr);
  if (!isNaN(tamanho)) return resposta.substring(inicio, inicio + tamanho);
  return resposta.substring(inicio);
}

function parseProposicoes(html) {
  const proposicoes = [];
  const blocos = html.split('kt-widget5__item');

  for (let i = 1; i < blocos.length; i++) {
    const bloco = blocos[i];

    const idMatch = bloco.match(/ID:<\/span>\s*<span[^>]*>(\d+)<\/span>/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const tituloMatch = bloco.match(/<a\s+href="([^"]+)"\s+class="kt-widget5__title"[^>]*>\s*([^<]+?)\s*<\/a>/);
    const href = tituloMatch ? tituloMatch[1].replace(/&amp;/g, '&') : '';
    const url = href ? new URL(href, URL_ORIGEM).toString() : URL_BASE + '?ano=' + ANO + '&ano_proposicao=' + ANO;
    const titulo = tituloMatch ? tituloMatch[2].trim() : '-';

    const tipoNumMatch = titulo.match(/^(.+?)\s+n[°º]\s*(\d+)\/\d+/);
    const tipo = tipoNumMatch ? tipoNumMatch[1].trim() : titulo;
    const numero = tipoNumMatch ? tipoNumMatch[2] : '-';

    const ementaMatch = bloco.match(/kt-widget5__desc[^>]*>\s*([\s\S]+?)\s*<\/a>/);
    const ementa = ementaMatch
      ? ementaMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '-';

    const dataMatch = bloco.match(/Data:<\/span>\s*<span[^>]*>([^<]+)<\/span>/);
    const data = dataMatch ? dataMatch[1].trim() : '-';

    const autorMatch = bloco.match(/Autor\(es\) da Proposição:<\/span>\s*<span[^>]*>([\s\S]+?)<\/span>/);
    let autor = '-';
    if (autorMatch) {
      autor = autorMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    }

    const processoMatch = bloco.match(/Processo N°:<\/span>\s*<a[^>]*>([^<]+)<\/a>/);
    const processo = processoMatch ? processoMatch[1].trim() : '-';

    proposicoes.push({ id, tipo, numero, ementa, data, autor, processo, url });
  }

  return proposicoes;
}

// ─── Requisições ─────────────────────────────────────────────────────────────

const HEADERS_BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function carregarPaginaInicial() {
  const url = `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`;
  console.log(`📥 Carregando página inicial: ${url}`);

  const resp = await fetch(url, { headers: HEADERS_BASE });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} na página inicial`);

  const html = await resp.text();
  const viewState = extrairViewState(html);
  const viewStateGen = extrairViewStateGenerator(html);
  const eventValidation = extrairEventValidation(html);

  if (!viewState) throw new Error('Não foi possível extrair __VIEWSTATE');

  const proposicoesPag1 = parseProposicoes(html);
  const totalMatch = html.match(/Localizada\(s\)\s*<strong>(\d+)<\/strong>/);
  const total = totalMatch ? parseInt(totalMatch[1]) : 0;
  const totalPaginas = Math.ceil(total / ITENS_POR_PAGINA);
  const cookies = resp.headers.get('set-cookie') || '';

  console.log(`✅ Página inicial OK. Total: ${total} proposições (~${totalPaginas} págs com ${ITENS_POR_PAGINA}/pág)`);
  console.log(`📊 Página 1 (10 itens): ${proposicoesPag1.length} proposições`);

  return { viewState, viewStateGen, eventValidation, proposicoesPag1, total, totalPaginas, cookies };
}

async function mudarPara50Itens({ viewState, viewStateGen, eventValidation, cookies }) {
  const body = new URLSearchParams({
    'ctl00$scm_principal': 'ctl00$ContentPlaceHolder1$upp_consultaProducao|ctl00$ContentPlaceHolder1$ddl_ItensExibidos',
    '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$ddl_ItensExibidos',
    '__EVENTARGUMENT': '',
    '__LASTFOCUS': '',
    '__VIEWSTATE': viewState,
    '__VIEWSTATEGENERATOR': viewStateGen || '',
    '__EVENTVALIDATION': eventValidation,
    'ctl00$ContentPlaceHolder1$id_proposicao': '123456',
    'ctl00$ContentPlaceHolder1$txt_nome': '',
    'ctl00$ContentPlaceHolder1$txt_email': '',
    'ctl00$ContentPlaceHolder1$txt_email_confirmacao': '',
    'ctl00$ContentPlaceHolder1$ddl_ItensExibidos': String(ITENS_POR_PAGINA),
    '__ASYNCPOST': 'true',
  });

  const resp = await fetch(`${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`, {
    method: 'POST',
    headers: {
      ...HEADERS_BASE,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-MicrosoftAjax': 'Delta=true',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`,
      ...(cookies ? { 'Cookie': cookies } : {}),
    },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status} ao mudar itens/página`);

  const texto = await resp.text();
  const novoViewState = extrairViewStateDeResposta(texto);
  const novoEventValidation = extrairEventValidationDeResposta(texto);
  const htmlPanel = extrairHtmlUpdatePanel(texto);
  const proposicoes = htmlPanel ? parseProposicoes(htmlPanel) : [];

  console.log(`✅ Mudou para ${ITENS_POR_PAGINA} itens/pág. Proposições na pág 1: ${proposicoes.length}`);

  return {
    viewState: novoViewState || viewState,
    viewStateGen,
    eventValidation: novoEventValidation || eventValidation,
    proposicoes,
    cookies,
  };
}

async function buscarPagina(numeroPagina, estadoAtual) {
  const { viewState, viewStateGen, eventValidation, cookies } = estadoAtual;
  const idx = String(numeroPagina - 1).padStart(2, '0');
  const eventoTarget = `ctl00$ContentPlaceHolder1$rptPaging$ctl${idx}$lbPaging`;

  const body = new URLSearchParams({
    'ctl00$scm_principal': `ctl00$ContentPlaceHolder1$upp_consultaProducao|${eventoTarget}`,
    '__EVENTTARGET': eventoTarget,
    '__EVENTARGUMENT': '',
    '__LASTFOCUS': '',
    '__VIEWSTATE': viewState,
    '__VIEWSTATEGENERATOR': viewStateGen || '',
    '__EVENTVALIDATION': eventValidation,
    'ctl00$ContentPlaceHolder1$id_proposicao': '123456',
    'ctl00$ContentPlaceHolder1$txt_nome': '',
    'ctl00$ContentPlaceHolder1$txt_email': '',
    'ctl00$ContentPlaceHolder1$txt_email_confirmacao': '',
    'ctl00$ContentPlaceHolder1$ddl_ItensExibidos': String(ITENS_POR_PAGINA),
    '__ASYNCPOST': 'true',
  });

  const resp = await fetch(`${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`, {
    method: 'POST',
    headers: {
      ...HEADERS_BASE,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-MicrosoftAjax': 'Delta=true',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`,
      ...(cookies ? { 'Cookie': cookies } : {}),
    },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status} na página ${numeroPagina}`);

  const texto = await resp.text();
  const novoViewState = extrairViewStateDeResposta(texto);
  const novoEventValidation = extrairEventValidationDeResposta(texto);
  const htmlPanel = extrairHtmlUpdatePanel(texto);
  const proposicoes = htmlPanel ? parseProposicoes(htmlPanel) : [];

  return {
    viewState: novoViewState || viewState,
    viewStateGen,
    eventValidation: novoEventValidation || eventValidation,
    proposicoes,
    cookies,
  };
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

async function buscarProposicoes(idsVistos, primeiroRun) {
  const inicial = await carregarPaginaInicial();
  await sleep(1500);

  let estadoAtual = await mudarPara50Itens(inicial);
  await sleep(1500);

  const todasProposicoes = [...estadoAtual.proposicoes];
  const todasNovasPag1 = estadoAtual.proposicoes.filter(p => !idsVistos.has(p.id));

  if (!primeiroRun && todasNovasPag1.length === 0) {
    console.log('✅ Nenhuma novidade na primeira página. Parando.');
    // Mesmo sem novidades, marca IDs da pág 1 como vistos
    todasProposicoes.forEach(p => idsVistos.add(String(p.id)));
    return [];
  }
  const totalPaginas = Math.ceil(inicial.total / ITENS_POR_PAGINA);
  const maxPag = primeiroRun ? Math.min(MAX_PAGINAS_PRIMEIRO_RUN, totalPaginas) : totalPaginas;

  for (let pag = 2; pag <= maxPag; pag++) {
    console.log(`📄 Página ${pag}/${maxPag}...`);
    await sleep(2000);

    try {
      estadoAtual = await buscarPagina(pag, estadoAtual);
      console.log(`   → ${estadoAtual.proposicoes.length} proposições`);
      todasProposicoes.push(...estadoAtual.proposicoes);

      if (!primeiroRun) {
        const novas = estadoAtual.proposicoes.filter(p => !idsVistos.has(p.id));
        if (novas.length === 0) {
          console.log(`✅ Sem novidades na página ${pag}. Parando.`);
          break;
        }
      }
    } catch (err) {
      console.error(`❌ Erro na página ${pag}: ${err.message}`);
      break;
    }
  }

  // Deduplica por ID (evita duplicatas entre páginas)
  const vistoNessaColeta = new Map();
  for (const p of todasProposicoes) {
    if (!vistoNessaColeta.has(p.id)) vistoNessaColeta.set(p.id, p);
  }
  const unicas = Array.from(vistoNessaColeta.values());

  // Marca TODOS os IDs coletados como vistos (independente do tipo)
  // para não reprocessar proposições de tipos não monitorados em runs futuros
  unicas.forEach(p => idsVistos.add(String(p.id)));

  // Retorna apenas as novas dos tipos monitorados para o email
  return unicas.filter(p => tipoMonitorado(p.tipo));
}

// ─── Email ────────────────────────────────────────────────────────────────────

const ORDEM_TIPOS = [
  'Projeto de Lei',
  'Projeto de Lei Complementar',
  'Projeto de Lei Iniciativa Popular',
  'Projeto de Decreto Legislativo',
  'Projeto de Resolução',
  'Proposta de Emenda à Lei Orgânica',
  'Mensagem',
  'Veto',
  'P. de Indicação',
  'Requerimento de Informação',
  'Audiência Pública - Externa',
  'Audiência Pública-Interno',
];

function ordemTipo(tipo) {
  const idx = ORDEM_TIPOS.findIndex(t => t.toLowerCase() === tipo.toLowerCase());
  return idx === -1 ? 99 : idx;
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra', 'BRT'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numero) return '';
  if (numero.includes('/') || !ano) return numero;
  return numero + '/' + ano;
}

function radar03BlocoEmail(novas) {
  const seen = new Set();
  return (novas || []).map(p => {
    const tipo = String(p?.tipo ?? p?.sigla ?? p?.rotulo ?? '').trim();
    const numero = radar03Numero(p);
    if (!tipo || !numero) return '';
    const row = `${tipo} ${numero}`;
    const key = row.toUpperCase();
    if (seen.has(key)) return '';
    seen.add(key);
    return row;
  }).filter(Boolean).join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PL': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || p?.codigo || p?.projeto_id || p?.id_proposicao || ''),
      ementa: String(p?.ementa || p?.resumo || p?.titulo || '').trim(),
      link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
      clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
    };
    let atual = porTipo.get(tipo);
    if (!atual) {
      atual = { ...itemCaptado, itens: [] };
      porTipo.set(tipo, atual);
    }
    atual.itens.push(itemCaptado);
    if (partes.numeroInt > atual.numeroInt) {
      atual.numeroInt = partes.numeroInt;
      atual.numero = partes.numero;
      atual.ano = partes.ano || String(p?.ano || '');
      atual.id = itemCaptado.id;
      atual.ementa = itemCaptado.ementa;
      atual.link = itemCaptado.link;
      atual.clienteSugestao = itemCaptado.clienteSugestao;
    }
  });
  return Array.from(porTipo.values()).map(rec => {
    rec.itens.sort((a, b) => a.numeroInt - b.numeroInt);
    return rec;
  });
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      const detalhes = Array.isArray(rec.itens) && rec.itens.length ? rec.itens : [rec];
      const existentesTipo = casa.items.filter(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      const baseAtual = existentesTipo.reduce((max, i) => {
        const n = Number.parseInt(String(i?.base || i?.mon || 0), 10) || 0;
        return Math.max(max, n);
      }, 0);

      detalhes.forEach(det => {
        let item = casa.items.find(i =>
          (det.id && i?.radar03Id === det.id) ||
          (radar03TipoControle(i?.tipo || '') === det.tipo &&
            Number.parseInt(String(i?.mon || 0), 10) === det.numeroInt &&
            String(i?.link || '') === String(det.link || ''))
        );
        if (!item) {
          item = { tipo: det.tipo, base: baseAtual, mon: det.numeroInt, radar03Id: det.id || '' };
          casa.items.push(item);
        }

        const base = Number.parseInt(String(item.base || baseAtual || 0), 10) || 0;
        item.tipo = det.tipo;
        item.mon = det.numeroInt;
        item.delta = det.numeroInt === base ? 0 : 1;
        item.sentido = det.numeroInt === base ? 'bate com o controle' : 'captado individualmente na fonte';
        item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
        item.ementa = det.ementa || item.ementa || '';
        item.link = det.link || item.link || '';
        item.clienteSugestao = det.clienteSugestao || item.clienteSugestao || '';
        item.radar03Id = det.id || item.radar03Id || '';
        item.listaReal03 = true;
      });
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03BlocoEmail(novas),
    fonte: radar03PrimeiraFonte(novas),
  });
  return `${RADAR03_URL}?${params.toString()}`;
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return '';
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(novas) {
  anotarClientesCitados(novas);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const tiposOrdenados = Object.keys(porTipo).sort((a, b) => ordemTipo(a) - ordemTipo(b));

  const linhas = tiposOrdenados.map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo]
      .sort((a, b) => (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0))
      .map(p => `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.tipo || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap"><a href="${p.url || `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`}" style="color:#003366;font-weight:bold;text-decoration:none">${p.numero || '-'}/${ANO}</a></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data ? p.data.substring(0, 16) : '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${renderizarEmentaCliente(p)}</td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  const html = `
      ${renderRadar03EmailButton(novas)}
    <div style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ Câmara Municipal de Vitória — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666;font-size:13px">Câmara Municipal de Vitória · Monitoramento automático · ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left">Tipo</th>
            <th style="padding:10px;text-align:left">Número</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://camarasempapel.cmv.es.gov.br/spl/consulta-producao.aspx?ano=${ANO}&ano_proposicao=${ANO}">Portal da Câmara Municipal de Vitória</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor Vitória" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ Vitória: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado: ${novas.length} proposições novas.`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

(async () => {
  console.log('🚀 Monitor CMV-ES iniciado');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);
  console.log(`🔍 Tipos monitorados: ${TIPOS_MONITORADOS.length}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas.map(String));
  const primeiroRun = idsVistos.size === 0;

  console.log(`📁 IDs já vistos: ${idsVistos.size} | Primeiro run: ${primeiroRun}`);

  try {
    const novas = await buscarProposicoes(idsVistos, primeiroRun);
    console.log(`🆕 Proposições novas (tipos monitorados): ${novas.length}`);

    if (novas.length > 0) {
      await sincronizarRadar03(novas);
    await enviarEmail(novas);
    } else {
      console.log('✅ Sem novidades nos tipos monitorados. Nada a enviar.');
    }

    // idsVistos já foi atualizado com TODOS os IDs coletados dentro de buscarProposicoes
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);

  } catch (err) {
    console.error(`❌ Erro fatal: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
})();
