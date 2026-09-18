/* Funções compartilhadas entre a interface do garçom e a do cliente. */

const CHAVE_TOKEN = 'restaurante.token';

/* ---------------------------------------------------------------- dinheiro */

// Todo valor trafega em centavos (inteiro) para não ter erro de arredondamento.
function reais(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

// Aceita "45", "45,90", "45.90", "R$ 45,90"
function paraCentavos(texto) {
  const limpo = String(texto).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '');
  const numero = Number(limpo.replace(',', '.'));
  if (!Number.isFinite(numero)) return NaN;
  return Math.round(numero * 100);
}

function horario(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function tempoRelativo(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

function escapar(texto) {
  const d = document.createElement('div');
  d.textContent = texto ?? '';
  return d.innerHTML;
}

/* --------------------------------------------------------------------- API */

const token = {
  ler: () => localStorage.getItem(CHAVE_TOKEN),
  gravar: (t) => localStorage.setItem(CHAVE_TOKEN, t),
  apagar: () => localStorage.removeItem(CHAVE_TOKEN),
};

async function api(caminho, opcoes = {}) {
  const cabecalhos = { 'Content-Type': 'application/json', ...(opcoes.headers || {}) };
  const t = token.ler();
  if (t) cabecalhos.Authorization = `Bearer ${t}`;

  const resposta = await fetch(`/api${caminho}`, {
    ...opcoes,
    headers: cabecalhos,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });

  let dados = {};
  try {
    dados = await resposta.json();
  } catch {
    /* resposta sem corpo */
  }

  if (!resposta.ok) {
    const falha = new Error(dados.erro || `Falha na requisição (${resposta.status})`);
    falha.status = resposta.status;
    falha.dados = dados;
    throw falha;
  }
  return dados;
}

/* ------------------------------------------------------ atualização ao vivo */

// O servidor empurra eventos por SSE; se a conexão cair, o navegador reconecta.
function ouvirEventos(aoReceber) {
  let fonte;
  const conectar = () => {
    fonte = new EventSource('/api/stream');
    for (const evento of ['mesas', 'pedidos', 'saldo', 'cardapio', 'recargas']) {
      fonte.addEventListener(evento, (e) => {
        let dados = {};
        try {
          dados = JSON.parse(e.data);
        } catch {
          /* evento sem corpo */
        }
        aoReceber(evento, dados);
      });
    }
    fonte.onerror = () => {
      fonte.close();
      setTimeout(conectar, 3000);
    };
  };
  conectar();
}

/* ------------------------------------------------------------------ avisos */

function torrada(mensagem, ruim = false) {
  let caixa = document.querySelector('.torradas');
  if (!caixa) {
    caixa = document.createElement('div');
    caixa.className = 'torradas';
    document.body.appendChild(caixa);
  }
  const el = document.createElement('div');
  el.className = `torrada${ruim ? ' ruim' : ''}`;
  el.textContent = mensagem;
  caixa.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(22px)';
    setTimeout(() => el.remove(), 320);
  }, 3400);
}

/* ------------------------------------------------------------------ modais */

function abrirModal(id) {
  document.getElementById(id)?.classList.add('aberto');
}

function fecharModal(id) {
  document.getElementById(id)?.classList.remove('aberto');
}

// Clicar no fundo escuro fecha a janela — menos as marcadas como obrigatórias,
// que só saem respondendo o que pedem.
document.addEventListener('click', (e) => {
  const fundo = e.target;
  if (fundo.classList?.contains('fundo-modal') && !fundo.dataset.obrigatorio) {
    fundo.classList.remove('aberto');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document
      .querySelectorAll('.fundo-modal.aberto:not([data-obrigatorio])')
      .forEach((m) => m.classList.remove('aberto'));
  }
});
