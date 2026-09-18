/* Interface do garçom: mesas, recarga dos cartões, fila de pedidos e cardápio. */

const app = {
  garcom: null,
  mesas: [],
  resumo: null,
  cardapio: [],
  fila: [],
  recargas: [],   // recargas pedidas pelos clientes, esperando liberação
  mesaAberta: null,   // número da mesa exibida no modal
  detalhe: null,      // { mesa, pedidos, extrato }
  valorEscolhido: null,
};

const VALORES_RAPIDOS = [2000, 5000, 10000, 15000, 20000, 30000];

const LEGENDA = {
  recebido: 'Recebido',
  preparando: 'Preparando',
  pronto: 'Pronto',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
};

const PROXIMO = { recebido: 'preparando', preparando: 'pronto', pronto: 'entregue' };

/* ------------------------------------------------------------------- login */

async function entrar(pin) {
  const dados = await api('/login', { method: 'POST', body: { pin } });
  token.gravar(dados.token);
  app.garcom = dados.garcom;
}

function mostrarLogin() {
  document.getElementById('telaLogin').hidden = false;
  document.getElementById('telaPainel').hidden = true;
  document.getElementById('btnSair').hidden = true;
  document.getElementById('nomeGarcom').textContent = '';
}

async function sair() {
  try {
    await api('/logout', { method: 'POST' });
  } catch {
    /* sessão já pode ter expirado */
  }
  token.apagar();
  app.garcom = null;
  // Volta ao portal: de lá dá para entrar como cliente ou logar de novo.
  location.href = '/';
}

/* --------------------------------------------------------------- dados */

async function atualizar() {
  const [mesas, resumo, fila, cardapio, recargas] = await Promise.all([
    api('/mesas'),
    api('/resumo'),
    api('/pedidos?ativos=1'),
    api('/cardapio?todos=1'),
    api('/recargas'),
  ]);
  app.mesas = mesas.mesas;
  app.resumo = resumo;
  app.fila = fila.pedidos;
  app.cardapio = cardapio.itens;
  app.recargas = recargas.recargas;

  desenharNumeros();
  desenharRecargas();
  desenharMesas();
  desenharFila();
  desenharCardapio();

  if (app.mesaAberta !== null) await carregarDetalhe(app.mesaAberta);
}

async function carregarDetalhe(numero) {
  app.detalhe = await api(`/mesas/${numero}`);
  desenharDetalhe();
}

/* ------------------------------------------------------------- desenho */

function desenharNumeros() {
  const r = app.resumo;
  document.getElementById('numerosSalao').innerHTML = `
    <div class="numero-box">
      <div class="rot">Mesas ocupadas</div>
      <div class="val">${r.mesas_ocupadas}<span style="font-size:17px;opacity:.6">/${r.mesas_total}</span></div>
    </div>
    <div class="numero-box clara">
      <div class="rot">Saldo nos cartões</div>
      <div class="val">${reais(r.saldo_em_cartoes)}</div>
    </div>
    <div class="numero-box clara">
      <div class="rot">Consumo hoje</div>
      <div class="val">${reais(r.caixa.consumo)}</div>
    </div>
    <div class="numero-box">
      <div class="rot">Pedidos na fila</div>
      <div class="val">${r.pedidos_ativos}</div>
    </div>
    <div class="numero-box${r.recargas_pendentes ? ' urgente' : ''}">
      <div class="rot">Recargas a liberar</div>
      <div class="val">${r.recargas_pendentes}</div>
    </div>`;
}

function desenharRecargas() {
  const bloco = document.getElementById('blocoRecargas');
  const lista = document.getElementById('listaRecargas');
  bloco.hidden = !app.recargas.length;
  if (!app.recargas.length) return;

  lista.innerHTML = app.recargas
    .map(
      (r) => `
    <article class="recarga">
      <div class="topo-recarga">
        <span class="mesa-recarga">Mesa ${r.mesa}</span>
        <span class="tag tag-recebido">${escapar(r.forma_pgto)}</span>
        <span class="quando">${tempoRelativo(r.criado_em)}</span>
      </div>
      <div class="valor-recarga">${reais(r.valor)}</div>
      <p>${r.cliente_nome ? `<b>👤 ${escapar(r.cliente_nome)}</b> — receba` : 'Receba'}
         ${reais(r.valor)} em ${escapar(r.forma_pgto)} e libere o valor no cartão.</p>
      <div class="acoes-recarga">
        <button class="btn btn-p" data-liberar="${r.id}" data-valor="${r.valor}" data-mesa="${r.mesa}">
          ✓ Recebi, liberar
        </button>
        <button class="btn btn-p btn-vazio" data-recusar="${r.id}">Recusar</button>
      </div>
    </article>`
    )
    .join('');

  lista.querySelectorAll('[data-liberar]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const dados = await api(`/recargas/${b.dataset.liberar}/liberar`, { method: 'POST' });
        torrada(`Mesa ${b.dataset.mesa}: ${reais(Number(b.dataset.valor))} liberados · saldo ${reais(dados.saldo)}`);
        await atualizar();
      } catch (e) {
        torrada(e.message, true);
        b.disabled = false;
      }
    })
  );

  lista.querySelectorAll('[data-recusar]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Recusar este pedido de recarga?')) return;
      b.disabled = true;
      try {
        await api(`/recargas/${b.dataset.recusar}/recusar`, { method: 'POST' });
        torrada('Pedido de recarga recusado');
        await atualizar();
      } catch (e) {
        torrada(e.message, true);
        b.disabled = false;
      }
    })
  );
}

function desenharMesas() {
  document.getElementById('gradeMesas').innerHTML = app.mesas
    .map((m) => {
      const ocupada = m.status === 'ocupada';
      const semSaldo = ocupada && m.saldo <= 0;
      const pendente = m.recarga_pendente > 0;
      return `
      <button class="mesa${ocupada ? ' ocupada' : ''}${semSaldo || pendente ? ' alerta' : ''}" data-mesa="${m.numero}">
        <div class="cabeca">
          <span class="num">${String(m.numero).padStart(2, '0')}</span>
          <span class="tag tag-${m.status}">${ocupada ? 'Ocupada' : 'Livre'}</span>
        </div>
        <div class="saldo-mesa">${reais(m.saldo)}</div>
        <div class="info">
          <span>${m.lugares} lugares</span>
          <span>${m.pedidos_abertos ? `${m.pedidos_abertos} pedido(s)` : '—'}</span>
        </div>
        <div class="info">
          <span>${ocupada && m.aberta_em ? `aberta ${tempoRelativo(m.aberta_em)}` : 'sem cliente'}</span>
          <span>${semSaldo ? '⚠️ sem saldo' : ''}</span>
        </div>
        ${pendente ? `<div class="faixa-recarga">💰 ${reais(m.recarga_pendente)} a liberar</div>` : ''}
      </button>`;
    })
    .join('');

  document.querySelectorAll('[data-mesa]').forEach((b) =>
    b.addEventListener('click', () => abrirMesa(Number(b.dataset.mesa)))
  );
}

function cartaoPedido(p, { comMesa = true } = {}) {
  const proximo = PROXIMO[p.status];
  return `
  <article class="pedido">
    <div class="cabeca">
      <span class="cod">#${p.id}${comMesa ? ` · Mesa ${p.mesa}` : ''}</span>
      ${p.cliente_nome ? `<span class="tag tag-livre">👤 ${escapar(p.cliente_nome)}</span>` : ''}
      <span class="tag tag-${p.status}">${LEGENDA[p.status]}</span>
      <span class="quando">${horario(p.criado_em)} · ${tempoRelativo(p.criado_em)}</span>
    </div>
    <ul>
      ${p.itens
        .map(
          (i) =>
            `<li><span>${i.emoji} ${i.qtd}× ${escapar(i.nome)}</span><span>${reais(i.preco_unit * i.qtd)}</span></li>`
        )
        .join('')}
    </ul>
    ${p.observacao ? `<div class="obs">📝 ${escapar(p.observacao)}</div>` : ''}
    <div class="acoes">
      <span class="valor">${reais(p.total)}</span>
      ${
        proximo
          ? `<button class="btn btn-p" data-status="${proximo}" data-pedido="${p.id}">
               ${proximo === 'preparando' ? 'Mandar p/ cozinha' : proximo === 'pronto' ? 'Marcar pronto' : 'Entregar'}
             </button>`
          : ''
      }
      ${
        p.status !== 'cancelado' && p.status !== 'entregue'
          ? `<button class="btn btn-p btn-vazio" data-status="cancelado" data-pedido="${p.id}">Cancelar</button>`
          : ''
      }
    </div>
  </article>`;
}

function ligarBotoesStatus(raiz) {
  raiz.querySelectorAll('[data-pedido]').forEach((b) =>
    b.addEventListener('click', async () => {
      const status = b.dataset.status;
      if (status === 'cancelado' && !confirm('Cancelar este pedido e estornar o valor no cartão?'))
        return;
      b.disabled = true;
      try {
        await api(`/pedidos/${b.dataset.pedido}/status`, { method: 'PATCH', body: { status } });
        torrada(status === 'cancelado' ? 'Pedido cancelado e valor estornado' : `Pedido → ${LEGENDA[status]}`);
        await atualizar();
      } catch (e) {
        torrada(e.message, true);
        b.disabled = false;
      }
    })
  );
}

function desenharFila() {
  const caixa = document.getElementById('listaFila');
  document.getElementById('contaFila').textContent = app.fila.length ? `(${app.fila.length})` : '';

  if (!app.fila.length) {
    caixa.innerHTML = `<div class="vazio"><span class="icone">✅</span>
      Nenhum pedido em aberto. Cozinha em dia!</div>`;
    return;
  }
  // Mais antigos primeiro: é essa a ordem em que precisam sair.
  caixa.innerHTML = [...app.fila].reverse().map((p) => cartaoPedido(p)).join('');
  ligarBotoesStatus(caixa);
}

function desenharCardapio() {
  document.getElementById('listaCategorias').innerHTML = [
    ...new Set(app.cardapio.map((i) => i.categoria)),
  ]
    .map((c) => `<option value="${escapar(c)}"></option>`)
    .join('');

  document.getElementById('listaCardapio').innerHTML = app.cardapio
    .map(
      (i) => `
    <article class="item${i.disponivel ? '' : ' esgotado'}">
      <div class="emoji">${i.emoji}</div>
      <div class="corpo">
        <h3>${escapar(i.nome)}</h3>
        <p>${escapar(i.categoria)}${i.descricao ? ` · ${escapar(i.descricao)}` : ''}</p>
        <div class="baixo">
          <span class="preco">${reais(i.preco)}</span>
          <button class="btn btn-p ${i.disponivel ? 'btn-vazio' : ''}" data-item="${i.id}" data-disp="${i.disponivel ? 0 : 1}">
            ${i.disponivel ? 'Marcar esgotado' : 'Voltar ao cardápio'}
          </button>
        </div>
      </div>
    </article>`
    )
    .join('');

  document.querySelectorAll('[data-item]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/cardapio/${b.dataset.item}`, {
          method: 'PATCH',
          body: { disponivel: b.dataset.disp === '1' },
        });
        await atualizar();
      } catch (e) {
        torrada(e.message, true);
        b.disabled = false;
      }
    })
  );
}

/* ------------------------------------------------------- modal de uma mesa */

function abrirMesa(numero) {
  app.mesaAberta = numero;
  app.valorEscolhido = null;
  document.getElementById('campoValor').value = '';
  document.getElementById('erroRecarga').innerHTML = '';
  abrirModal('modalMesa');
  carregarDetalhe(numero).catch((e) => torrada(e.message, true));
}

function desenharValoresRapidos() {
  document.getElementById('valoresRapidos').innerHTML = VALORES_RAPIDOS.map(
    (v) =>
      `<button class="chip-valor${app.valorEscolhido === v ? ' ativa' : ''}" data-valor="${v}">${reais(v)}</button>`
  ).join('');

  document.querySelectorAll('[data-valor]').forEach((b) =>
    b.addEventListener('click', () => {
      app.valorEscolhido = Number(b.dataset.valor);
      document.getElementById('campoValor').value = '';
      desenharValoresRapidos();
    })
  );
}

function desenharDetalhe() {
  const { mesa, pedidos, extrato } = app.detalhe;
  const ocupada = mesa.status === 'ocupada';

  document.getElementById('tituloMesa').textContent = `Mesa ${mesa.numero}`;
  document.getElementById('mesaNumeroCartao').textContent = String(mesa.numero).padStart(4, '0');
  document.getElementById('mesaSaldo').textContent = reais(mesa.saldo);
  document.getElementById('mesaConsumo').textContent = reais(mesa.consumo);
  document.getElementById('mesaAberta').textContent = mesa.aberta_em
    ? `${horario(mesa.aberta_em)} · ${escapar(mesa.garcom || '')}`
    : '—';
  document.getElementById('cartaoMesa').classList.toggle('sem-saldo', ocupada && mesa.saldo <= 0);

  document.getElementById('btnAbrirMesa').disabled = ocupada;
  document.getElementById('btnFecharMesa').disabled = !ocupada;
  document.getElementById('linkCliente').href = `/cliente?mesa=${mesa.numero}`;

  desenharValoresRapidos();

  const caixaPedidos = document.getElementById('pedidosDaMesa');
  caixaPedidos.innerHTML = pedidos.length
    ? pedidos.map((p) => cartaoPedido(p, { comMesa: false })).join('')
    : `<div class="vazio"><span class="icone">🥢</span>Nenhum pedido nesta mesa.</div>`;
  ligarBotoesStatus(caixaPedidos);

  const icones = { recarga: '💰', consumo: '🍜', estorno: '↩️', devolucao: '🏁' };
  document.getElementById('extratoDaMesa').innerHTML = extrato.length
    ? extrato
        .map(
          (t) => `
      <li>
        <span style="font-size:22px">${icones[t.tipo] || '•'}</span>
        <span class="desc">
          <b>${escapar(t.descricao || t.tipo)}</b>
          <small>${horario(t.criado_em)}${t.garcom ? ` · ${escapar(t.garcom)}` : ''}${
            t.forma_pgto ? ` · ${escapar(t.forma_pgto)}` : ''
          } · saldo ${reais(t.saldo_apos)}</small>
        </span>
        <span class="valor ${t.valor >= 0 ? 'entrada' : 'saida'}">
          ${t.valor >= 0 ? '+' : '−'}${reais(Math.abs(t.valor))}
        </span>
      </li>`
        )
        .join('')
    : `<div class="vazio"><span class="icone">🧾</span>Sem movimentação ainda.</div>`;
}

/* ------------------------------------------------------------------ ações */

async function recarregar() {
  const botao = document.getElementById('btnRecarregar');
  const caixaErro = document.getElementById('erroRecarga');
  const digitado = document.getElementById('campoValor').value.trim();
  const valor = digitado ? paraCentavos(digitado) : app.valorEscolhido;

  if (!Number.isFinite(valor) || valor <= 0) {
    caixaErro.innerHTML = `<div class="aviso aviso-erro">Escolha um valor rápido ou digite quanto o cliente vai colocar no cartão.</div>`;
    return;
  }

  botao.disabled = true;
  caixaErro.innerHTML = '';
  try {
    const dados = await api(`/mesas/${app.mesaAberta}/recarga`, {
      method: 'POST',
      body: { valor, forma_pgto: document.getElementById('campoForma').value },
    });
    torrada(`Mesa ${app.mesaAberta} recarregada com ${reais(valor)} · saldo ${reais(dados.saldo)}`);
    app.valorEscolhido = null;
    document.getElementById('campoValor').value = '';
    await atualizar();
  } catch (e) {
    caixaErro.innerHTML = `<div class="aviso aviso-erro">${escapar(e.message)}</div>`;
  } finally {
    botao.disabled = false;
  }
}

async function abrirMesaAgora() {
  try {
    await api(`/mesas/${app.mesaAberta}/abrir`, { method: 'POST' });
    torrada(`Mesa ${app.mesaAberta} aberta`);
    await atualizar();
  } catch (e) {
    torrada(e.message, true);
  }
}

async function fecharMesaAgora() {
  const mesa = app.detalhe.mesa;
  const aviso =
    mesa.saldo > 0
      ? `Fechar a mesa ${mesa.numero} e devolver ${reais(mesa.saldo)} de saldo ao cliente?`
      : `Fechar a mesa ${mesa.numero}?`;
  if (!confirm(aviso)) return;

  try {
    await api(`/mesas/${mesa.numero}/fechar`, { method: 'POST' });
    torrada(
      mesa.saldo > 0
        ? `Mesa ${mesa.numero} fechada · devolver ${reais(mesa.saldo)} ao cliente`
        : `Mesa ${mesa.numero} fechada`
    );
    fecharModal('modalMesa');
    app.mesaAberta = null;
    await atualizar();
  } catch (e) {
    // Pedidos em aberto: pergunta se fecha mesmo assim.
    if (e.status === 409 && confirm(`${e.message}. Fechar mesmo assim?`)) {
      await api(`/mesas/${mesa.numero}/fechar`, { method: 'POST', body: { forcar: true } });
      fecharModal('modalMesa');
      app.mesaAberta = null;
      await atualizar();
      return;
    }
    torrada(e.message, true);
  }
}

async function criarItem(e) {
  e.preventDefault();
  const preco = paraCentavos(document.getElementById('itemPreco').value);
  if (!Number.isFinite(preco) || preco <= 0) return torrada('Preço inválido', true);
  try {
    await api('/cardapio', {
      method: 'POST',
      body: {
        nome: document.getElementById('itemNome').value.trim(),
        preco,
        categoria: document.getElementById('itemCategoria').value.trim() || 'Outros',
        emoji: document.getElementById('itemEmoji').value.trim() || '🍜',
        descricao: document.getElementById('itemDescricao').value.trim(),
      },
    });
    e.target.reset();
    torrada('Item adicionado ao cardápio');
    await atualizar();
  } catch (err) {
    torrada(err.message, true);
  }
}

async function criarMesa(e) {
  e.preventDefault();
  const caixaErro = document.getElementById('erroNovaMesa');
  try {
    await api('/mesas', {
      method: 'POST',
      body: {
        numero: Number(document.getElementById('novaNumero').value),
        lugares: Number(document.getElementById('novaLugares').value) || 4,
      },
    });
    fecharModal('modalNovaMesa');
    e.target.reset();
    document.getElementById('novaLugares').value = 4;
    caixaErro.innerHTML = '';
    torrada('Mesa criada');
    await atualizar();
  } catch (err) {
    caixaErro.innerHTML = `<div class="aviso aviso-erro">${escapar(err.message)}</div>`;
  }
}

function trocarPainel(nome) {
  document.querySelectorAll('.aba[data-painel]').forEach((b) =>
    b.classList.toggle('ativa', b.dataset.painel === nome)
  );
  document.getElementById('painelMesas').hidden = nome !== 'mesas';
  document.getElementById('painelFila').hidden = nome !== 'fila';
  document.getElementById('painelCardapio').hidden = nome !== 'cardapio';
}

/* ------------------------------------------------------------------ início */

function ligarEventosDaTela() {
  document.querySelectorAll('.aba[data-painel]').forEach((b) =>
    b.addEventListener('click', () => trocarPainel(b.dataset.painel))
  );
  document.getElementById('btnRecarregar').addEventListener('click', recarregar);
  document.getElementById('btnAbrirMesa').addEventListener('click', abrirMesaAgora);
  document.getElementById('btnFecharMesa').addEventListener('click', fecharMesaAgora);
  document.getElementById('formItem').addEventListener('submit', criarItem);
  document.getElementById('formNovaMesa').addEventListener('submit', criarMesa);
  document.getElementById('btnNovaMesa').addEventListener('click', () => abrirModal('modalNovaMesa'));
  document.getElementById('btnSair').addEventListener('click', sair);
  document.getElementById('campoValor').addEventListener('input', () => {
    app.valorEscolhido = null;
    desenharValoresRapidos();
  });

  // O modal da mesa deixa de acompanhar a mesa quando é fechado.
  document.getElementById('modalMesa').addEventListener('click', (e) => {
    if (e.target.id === 'modalMesa') app.mesaAberta = null;
  });
  document.querySelector('#modalMesa .fechar').addEventListener('click', () => {
    app.mesaAberta = null;
  });
}

async function mostrarPainel() {
  document.getElementById('telaLogin').hidden = true;
  document.getElementById('telaPainel').hidden = false;
  document.getElementById('btnSair').hidden = false;
  document.getElementById('nomeGarcom').textContent = `👋 ${app.garcom.nome}`;
  await atualizar();
}

async function iniciar() {
  ligarEventosDaTela();

  document.getElementById('formLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const caixaErro = document.getElementById('erroLogin');
    caixaErro.innerHTML = '';
    try {
      await entrar(document.getElementById('campoPin').value.trim());
      document.getElementById('campoPin').value = '';
      await mostrarPainel();
    } catch (err) {
      caixaErro.innerHTML = `<div class="aviso aviso-erro" style="margin-top:12px">${escapar(err.message)}</div>`;
    }
  });

  // Sessão anterior ainda vale? Entra direto.
  if (token.ler()) {
    try {
      app.garcom = (await api('/eu')).garcom;
      await mostrarPainel();
    } catch {
      token.apagar();
      mostrarLogin();
    }
  } else {
    mostrarLogin();
  }

  // Pedido novo do cliente ou saldo alterado aparecem sem precisar recarregar a página.
  ouvirEventos(() => {
    if (app.garcom) atualizar().catch(() => {});
  });
}

iniciar();
