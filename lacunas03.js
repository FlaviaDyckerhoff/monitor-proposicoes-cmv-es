'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function decorate(options,items,casa,unavailable=false){
 if(!items.length&&!unavailable)return {...options};
 const url='https://doe.monitorlegislativo.com.br/controle03/?casa='+encodeURIComponent(casa);
 const title=unavailable?'Cobertura não conferida nesta mensagem':'Lacuna de PL — conferência e recuperação pendentes';
 const text=unavailable?'Não foi possível consultar a verificação de lacunas. Isso não significa ausência de PL.':items.slice(0,30).map(x=>`${x.tipo} ${x.numero}/${x.ano} — ${x.status==='confirmado_na_fonte'?'publicado na fonte; recuperação pendente':'sequência a conferir na fonte'}`).map(esc).join('<br>')+(items.length>30?'<br>Lista completa na 03.':'');
 const block=`<div data-lacunas03="1" style="background:#fff1f2;border:2px solid #dc2626;color:#991b1b;border-radius:6px;padding:12px;margin:12px 0"><b>🔴 ${esc(title)}</b><br>${text}<br><a href="${esc(url)}">Abrir lacunas na Controle 03</a><br>Conferência separada da incorporação no Monitor e da notificação de clientes.</div>`;
 return {...options,subject:(unavailable?'⚠️ Cobertura não conferida | ':'🔴 Lacuna de PL | ')+(options.subject||''),html:block+(options.html||''),...(options.text?{text:title+'\n'+items.map(x=>`${x.tipo} ${x.numero}/${x.ano}: ${x.status}`).join('\n')+'\n'+url+'\n'+options.text}:{})};
}
async function sendMail(transport,config,options){
 let items=[],unavailable=false;
 try{const u=new URL(config.stateUrl);u.pathname=u.pathname.replace(/\/state\/?$/,'/coverage-alerts');u.search='';u.searchParams.set('casa',config.casa);const r=await fetch(u,{headers:config.headers(),signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('coverage unavailable');const j=await r.json();if(j.ok!==true||!Array.isArray(j.items))throw Error('invalid coverage');items=j.items;}catch(_){unavailable=true;}
 return transport.sendMail(decorate(options,items,config.casa,unavailable));
}
module.exports={sendMail,decorate};
