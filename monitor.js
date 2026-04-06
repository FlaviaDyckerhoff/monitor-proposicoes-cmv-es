const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br';
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE || 'flavia@monitorlegislativo.com.br';
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const URL_BASE = 'https://camarasempapel.cmv.es.gov.br/spl/consulta-producao.aspx';
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

    const tituloMatch = bloco.match(/kt-widget5__title[^>]*>\s*([^<]+?)\s*<\/a>/);
    const titulo = tituloMatch ? tituloMatch[1].trim() : '-';

    const tipoNumMatch = titulo.match(/^(.+?)\s+n[°º]\s*(\d+)\/\d+/);
    const tipo = tipoNumMatch ? tipoNumMatch[1].trim() : titulo;
    const numero = tipoNumMatch ? tipoNumMatch[2] : '-';

    const ementaMatch = bloco.match(/kt-widget5__desc[^>]*>\s*([\s\S]+?)\s*<\/a>/);
    const ementa = ementaMatch
      ? ementaMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 250)
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

    proposicoes.push({ id, tipo, numero, ementa, data, autor, processo });
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

async function enviarEmail(novas) {
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
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap"><strong>${p.numero || '-'}/${ANO}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data ? p.data.substring(0, 16) : '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa || '-'}</td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ CMV-ES — ${novas.length} nova(s) proposição(ões)
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
        Acesse: <a href="https://camarasempapel.cmv.es.gov.br/spl/consulta-producao.aspx?ano=${ANO}&ano_proposicao=${ANO}">Portal CMV-ES</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor CMV-ES" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ CMV-ES: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
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
