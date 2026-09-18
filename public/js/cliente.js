/* Interface do cliente: cartão da mesa, cardápio e pedidos. */

const estado = {
  mesa: null,        // dados da mesa vinda do servidor
  itens: [],         // cardápio
  pedidos: [],
  extrato: [],
  carrinho: new Map(), // item_id -> quantidade
  categoria: null,
  recargaPendente: null, // recarga já pedida, esperando o garçom liberar
  valorRecarga: null,
  nome: '',              // como o cliente quer ser chamado nesta mesa
};

// O nome fica guardado por mesa: quem volta à mesma mesa não digita de novo.
const chaveNome = (mesa) => `cliente.nome.mesa${mesa}`;

function lerNomeSalvo(mesa) {
  try {
    return localStorage.getItem(chaveNome(mesa)) || '';
  } catch {
    return ''; // navegação privada ou armazenamento bloqueado
  }
}

function salvarNome(mesa, nome) {
  try {
    localStorage.setItem(chaveNome(mesa), nome);
    localStorage.setItem('cliente.nome.ultimo', nome); // sugestão ao trocar de mesa
  } catch {
    /* segue sem guardar: o nome vale para esta visita */
  }
}

function ultimoNomeUsado() {
  try {
    return localStorage.getItem('cliente.nome.ultimo') || '';
  } catch {
    return '';
  }
}

const VALORES_RECARGA = [2000, 5000, 10000, 15000, 20000, 30000];

const numeroDaURL = () => {
  const n = Number(new URLSearchParams(location.search).get('mesa'));
  return Number.isInteger(n) && n > 0 ? n : null;
};

/* ------------------------------------------------------------- carregamento */

async function carregar(numero) {
  const [dadosMesa, cardapio] = await Promise.all([
    api(`/mesas/${numero}`),
    api('/cardapio'),
  ]);
  estado.mesa = dadosMesa.mesa;
  estado.pedidos = dadosMesa.pedidos;
  estado.extrato = dadosMesa.extrato;
  estado.recargaPendente = dadosMesa.recarga_pendente;
  estado.itens = cardapio.itens;
  if (!estado.categoria) estado.categoria = categorias()[0] ?? null;
  desenharTudo();
}

async function recarregarMesa() {
  if (!estado.mesa) return;
  const dados = await api(`/mesas/${estado.mesa.numero}`);
  const pendenteAntes = estado.recargaPendente;
  const saldoAntes = estado.mesa.saldo;

  estado.mesa = dados.mesa;
  estado.pedidos = dados.pedidos;
  estado.extrato = dados.extrato;
  estado.recargaPendente = dados.recarga_pendente;
  desenharTudo();

  // O garçom acabou de liberar a recarga que estava esperando.
  if (pendenteAntes && !estado.recargaPendente && estado.mesa.saldo > saldoAntes) {
    torrada(`Recarga liberada! Saldo: ${reais(estado.mesa.saldo)}`);
  }
}

const categorias = () => [...new Set(estado.itens.map((i) => i.categoria))];

/* -------------------------------------------------------------- carrinho */

const totalCarrinho = () => {
  let total = 0;
  for (const [id, qtd] of estado.carrinho) {
    const item = estado.itens.find((i) => i.id === id);
    if (item) total += item.preco * qtd;
  }
  return total;
};

const qtdCarrinho = () => [...estado.carrinho.values()].reduce((s, q) => s + q, 0);

function mudarQtd(id, delta) {
  const atual = estado.carrinho.get(id) || 0;
  const nova = Math.max(0, Math.min(50, atual + delta));
  if (nova === 0) estado.carrinho.delete(id);
  else estado.carrinho.set(id, nova);
  atualizarContadores();
  desenharBarra();
}

function limparCarrinho() {
  estado.carrinho.clear();
  atualizarContadores();
  desenharBarra();
}

// Mexe só nos números e nos botões já desenhados: redesenhar a lista inteira
// perderia a rolagem e engoliria toques rápidos no celular.
function atualizarContadores() {
  const podePedir = estado.mesa?.status === 'ocupada';
  const saldoRestante = (estado.mesa?.saldo ?? 0) - totalCarrinho();

  for (const artigo of document.querySelectorAll('#listaItens .item')) {
    const id = Number(artigo.dataset.id);
    const item = estado.itens.find((i) => i.id === id);
    if (!item) continue;
    const qtd = estado.carrinho.get(id) || 0;
    artigo.querySelector('.contador span').textContent = qtd;
    artigo.querySelector('[data-menos]').disabled = qtd === 0;
    const mais = artigo.querySelector('[data-mais]');
    mais.disabled = !podePedir || !item.disponivel || item.preco > saldoRestante;
    mais.title = mais.disabled && item.preco > saldoRestante
      ? 'Saldo insuficiente para adicionar'
      : 'Adicionar';
  }
}

/* ------------------------------------------------------------- desenho */

function desenharTudo() {
  desenharCartao();
  desenharCategorias();
  desenharCardapio();
  desenharPedidos();
  desenharExtrato();
  desenharBarra();
}

function desenharCartao() {
  const m = estado.mesa;
  const aberta = m.status === 'ocupada';
  const consumo = m.consumo;

  document.getElementById('rotuloMesa').textContent = estado.nome
    ? `Mesa ${m.numero} · ${estado.nome}`
    : `Mesa ${m.numero}`;
  document.getElementById('quemEsta').innerHTML = estado.nome
    ? `<b>${escapar(estado.nome)}</b> na <b>mesa ${m.numero}</b>`
    : `Mesa ${m.numero}`;
  document.getElementById('numeroCartao').textContent = String(m.numero).padStart(4, '0');
  document.getElementById('saldoCartao').textContent = reais(m.saldo);
  document.getElementById('consumoCartao').textContent = reais(consumo);
  document.getElementById('situacaoCartao').textContent = aberta ? 'Mesa aberta' : 'Mesa fechada';
  document.getElementById('cartaoVirtual').classList.toggle('sem-saldo', aberta && m.saldo <= 0);
  document.title = `Mesa ${m.numero} — ${reais(m.saldo)}`;

  const pendente = estado.recargaPendente;
  const botao = document.getElementById('btnPedirRecarga');
  // Recarregar só faz sentido depois que o garçom abriu a mesa.
  botao.hidden = !aberta;
  botao.disabled = !!pendente;
  botao.textContent = pendente ? '⏳ Recarga aguardando o garçom' : '💰 Recarregar cartão';

  const aviso = document.getElementById('avisoMesa');
  if (pendente) {
    aviso.innerHTML = `<div class="aviso aviso-atencao">
      <b>${reais(pendente.valor)} aguardando o garçom.</b>
      Pedido em ${escapar(pendente.forma_pgto)} feito ${escapar(tempoRelativo(pendente.criado_em))}.
      Assim que ele receber o pagamento e liberar, o saldo entra no cartão.
      <button class="btn btn-p btn-vazio" id="btnCancelarRecarga" style="margin-top:10px">
        Cancelar pedido de recarga
      </button></div>`;
    document
      .getElementById('btnCancelarRecarga')
      .addEventListener('click', cancelarRecarga);
  } else if (!aberta) {
    aviso.innerHTML = `<div class="aviso aviso-atencao">
      <b>Mesa ainda não aberta.</b> Chame o garçom para abrir a mesa ${m.numero}.
      Depois disso você já pode recarregar o cartão por aqui e fazer o pedido —
      enquanto isso, dá para olhar o cardápio à vontade.</div>`;
  } else if (m.saldo <= 0) {
    aviso.innerHTML = `<div class="aviso aviso-erro">
      <b>Cartão sem saldo.</b> Peça uma recarga para voltar a pedir.</div>`;
  } else {
    aviso.innerHTML = '';
  }
}

function desenharCategorias() {
  const caixa = document.getElementById('categorias');
  caixa.innerHTML = categorias()
    .map(
      (c) =>
        `<button class="aba${c === estado.categoria ? ' ativa' : ''}" data-cat="${escapar(c)}">${escapar(c)}</button>`
    )
    .join('');
  caixa.querySelectorAll('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => {
      estado.categoria = b.dataset.cat;
      desenharCategorias();
      desenharCardapio();
    })
  );
}

function desenharCardapio() {
  const lista = document.getElementById('listaItens');
  const podePedir = estado.mesa?.status === 'ocupada';
  const visiveis = estado.itens.filter((i) => i.categoria === estado.categoria);
  const saldoRestante = (estado.mesa?.saldo ?? 0) - totalCarrinho();

  lista.innerHTML = visiveis
    .map((item) => {
      const qtd = estado.carrinho.get(item.id) || 0;
      const semSaldoPraMais = item.preco > saldoRestante;
      return `
      <article class="item${item.disponivel ? '' : ' esgotado'}" data-id="${item.id}">
        <div class="emoji">${item.emoji}</div>
        <div class="corpo">
          <h3>${escapar(item.nome)}</h3>
          <p>${escapar(item.descricao)}</p>
          <div class="baixo">
            <span class="preco">${reais(item.preco)}</span>
            <div class="contador">
              <button data-menos="${item.id}" ${qtd === 0 ? 'disabled' : ''} aria-label="Tirar um">−</button>
              <span>${qtd}</span>
              <button data-mais="${item.id}"
                ${!podePedir || !item.disponivel || semSaldoPraMais ? 'disabled' : ''}
                title="${semSaldoPraMais ? 'Saldo insuficiente para adicionar' : 'Adicionar'}"
                aria-label="Adicionar um">+</button>
            </div>
          </div>
        </div>
      </article>`;
    })
    .join('');

  lista.querySelectorAll('[data-mais]').forEach((b) =>
    b.addEventListener('click', () => mudarQtd(Number(b.dataset.mais), 1))
  );
  lista.querySelectorAll('[data-menos]').forEach((b) =>
    b.addEventListener('click', () => mudarQtd(Number(b.dataset.menos), -1))
  );
}

function desenharBarra() {
  const barra = document.getElementById('barraCarrinho');
  const n = qtdCarrinho();
  barra.classList.toggle('visivel', n > 0);
  document.getElementById('resumoQtd').textContent = `${n} ${n === 1 ? 'item' : 'itens'}`;
  document.getElementById('resumoTotal').textContent = reais(totalCarrinho());
}

function desenharPedidos() {
  const caixa = document.getElementById('listaPedidos');
  const ativos = estado.pedidos.filter((p) =>
    ['recebido', 'preparando', 'pronto'].includes(p.status)
  ).length;
  document.getElementById('contaPedidos').textContent = ativos ? `(${ativos})` : '';

  if (!estado.pedidos.length) {
    caixa.innerHTML = `<div class="vazio"><span class="icone">🥢</span>
      Nenhum pedido ainda. Escolha algo no cardápio!</div>`;
    return;
  }

  const legenda = {
    recebido: 'Recebido pela cozinha',
    preparando: 'Preparando',
    pronto: 'Pronto — sai já já',
    entregue: 'Entregue',
    cancelado: 'Cancelado (valor estornado)',
  };

  caixa.innerHTML = estado.pedidos
    .map(
      (p) => `
    <article class="pedido">
      <div class="cabeca">
        <span class="cod">Pedido #${p.id}</span>
        <span class="tag tag-${p.status}">${legenda[p.status]}</span>
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
      <div class="acoes"><span class="valor">${reais(p.total)}</span></div>
    </article>`
    )
    .join('');
}

function desenharExtrato() {
  const caixa = document.getElementById('listaExtrato');
  if (!estado.extrato.length) {
    caixa.innerHTML = `<div class="vazio"><span class="icone">🧾</span>
      Nada no extrato ainda. A primeira recarga aparece aqui.</div>`;
    return;
  }
  const icones = { recarga: '💰', consumo: '🍜', estorno: '↩️', devolucao: '🏁' };
  caixa.innerHTML = estado.extrato
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
    .join('');
}

/* ------------------------------------------------------------ envio pedido */

function abrirRevisao() {
  const linhas = [...estado.carrinho.entries()].map(([id, qtd]) => {
    const item = estado.itens.find((i) => i.id === id);
    return { item, qtd };
  });
  const total = totalCarrinho();

  document.getElementById('revisaoItens').innerHTML = linhas
    .map(
      ({ item, qtd }) => `
    <li>
      <span style="font-size:22px">${item.emoji}</span>
      <span class="desc"><b>${escapar(item.nome)}</b><small>${qtd} × ${reais(item.preco)}</small></span>
      <span class="valor">${reais(item.preco * qtd)}</span>
    </li>`
    )
    .join('');

  document.getElementById('revisaoTotal').textContent = reais(total);
  document.getElementById('revisaoSaldo').textContent = reais(estado.mesa.saldo - total);
  document.getElementById('erroPedido').innerHTML = '';
  abrirModal('modalPedido');
}

async function enviarPedido() {
  const botao = document.getElementById('btnEnviar');
  const erroCaixa = document.getElementById('erroPedido');
  botao.disabled = true;
  botao.textContent = 'Enviando...';

  try {
    const resposta = await api('/pedidos', {
      method: 'POST',
      body: {
        mesa: estado.mesa.numero,
        observacao: document.getElementById('campoObs').value.trim(),
        cliente_nome: estado.nome,
        itens: [...estado.carrinho.entries()].map(([item_id, qtd]) => ({ item_id, qtd })),
      },
    });
    estado.carrinho.clear();
    document.getElementById('campoObs').value = '';
    fecharModal('modalPedido');
    torrada(`Pedido #${resposta.pedido.id} enviado! Saldo: ${reais(resposta.saldo)}`);
    await recarregarMesa();
    trocarPainel('pedidos');
  } catch (e) {
    const falta = e.dados?.falta;
    erroCaixa.innerHTML = `<div class="aviso aviso-erro">${escapar(e.message)}${
      falta ? ` — faltam <b>${reais(falta)}</b>. Chame o garçom para recarregar.` : ''
    }</div>`;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Enviar pedido e debitar do cartão';
  }
}

/* ---------------------------------------------------------------- recarga */

function desenharValoresRecarga() {
  document.getElementById('valoresRecarga').innerHTML = VALORES_RECARGA.map(
    (v) =>
      `<button type="button" class="chip-valor${
        estado.valorRecarga === v ? ' ativa' : ''
      }" data-recarga="${v}">${reais(v)}</button>`
  ).join('');

  document.querySelectorAll('[data-recarga]').forEach((b) =>
    b.addEventListener('click', () => {
      estado.valorRecarga = Number(b.dataset.recarga);
      document.getElementById('recargaOutro').value = '';
      desenharValoresRecarga();
    })
  );
}

function abrirRecarga() {
  estado.valorRecarga = null;
  document.getElementById('recargaOutro').value = '';
  document.getElementById('erroRecarga').innerHTML = '';
  desenharValoresRecarga();
  abrirModal('modalRecarga');
}

async function pedirRecarga() {
  const botao = document.getElementById('btnEnviarRecarga');
  const caixaErro = document.getElementById('erroRecarga');
  const digitado = document.getElementById('recargaOutro').value.trim();
  const valor = digitado ? paraCentavos(digitado) : estado.valorRecarga;

  if (!Number.isFinite(valor) || valor <= 0) {
    caixaErro.innerHTML = `<div class="aviso aviso-erro">Escolha um valor ou digite quanto quer colocar no cartão.</div>`;
    return;
  }

  botao.disabled = true;
  botao.textContent = 'Chamando...';
  try {
    await api(`/mesas/${estado.mesa.numero}/recarga-pedido`, {
      method: 'POST',
      body: {
        valor,
        forma_pgto: document.getElementById('recargaForma').value,
        cliente_nome: estado.nome,
      },
    });
    fecharModal('modalRecarga');
    torrada(`Recarga de ${reais(valor)} pedida — o garçom já foi avisado`);
    await recarregarMesa();
  } catch (e) {
    caixaErro.innerHTML = `<div class="aviso aviso-erro">${escapar(e.message)}</div>`;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Chamar o garçom para liberar';
  }
}

async function cancelarRecarga() {
  if (!estado.recargaPendente) return;
  try {
    await api(`/recargas/${estado.recargaPendente.id}/cancelar`, { method: 'POST' });
    torrada('Pedido de recarga cancelado');
    await recarregarMesa();
  } catch (e) {
    torrada(e.message, true);
  }
}

/* ---------------------------------------------------------------- painéis */

function trocarPainel(nome) {
  document.querySelectorAll('.aba[data-painel]').forEach((b) =>
    b.classList.toggle('ativa', b.dataset.painel === nome)
  );
  document.getElementById('painelCardapio').hidden = nome !== 'cardapio';
  document.getElementById('painelPedidos').hidden = nome !== 'pedidos';
  document.getElementById('painelExtrato').hidden = nome !== 'extrato';
}

/* ------------------------------------------------------------------ início */

// Grade de escolha: só existem as mesas reais, então ninguém digita um número inválido.
async function mostrarEscolhaDeMesa(mensagemDeErro = null) {
  const tela = document.getElementById('telaEntrada');
  tela.hidden = false;
  document.getElementById('telaMesa').hidden = true;

  if (mensagemDeErro) {
    document.getElementById('erroEntrada').innerHTML =
      `<div class="aviso aviso-erro">${escapar(mensagemDeErro)}</div>`;
  }

  const grade = document.getElementById('gradeEscolha');
  grade.innerHTML = '<div class="vazio">Carregando as mesas...</div>';

  let mesas;
  try {
    mesas = (await api('/mesas-abertas')).mesas;
  } catch (e) {
    grade.innerHTML = `<div class="vazio"><span class="icone">📡</span>
      Não deu para falar com o sistema do salão. Chame o garçom.</div>`;
    return;
  }

  grade.innerHTML = mesas
    .map((m) => {
      const aberta = m.status === 'ocupada';
      return `
      <a class="escolha${aberta ? ' aberta' : ''}" href="cliente.html?mesa=${m.numero}">
        <span class="num-escolha">${String(m.numero).padStart(2, '0')}</span>
        <span class="lugares-escolha">${m.lugares} lugares</span>
        <span class="tag ${aberta ? 'tag-ocupada' : 'tag-livre'}">
          ${aberta ? 'Aberta' : 'Fechada'}
        </span>
      </a>`;
    })
    .join('');
}

async function iniciar() {
  const numero = numeroDaURL();

  if (!numero) {
    await mostrarEscolhaDeMesa();
    // Uma mesa aberta pelo garçom aparece na hora para quem está escolhendo.
    ouvirEventos((evento) => {
      if (evento === 'mesas') mostrarEscolhaDeMesa();
    });
    return;
  }

  try {
    await carregar(numero);
  } catch (e) {
    await mostrarEscolhaDeMesa(e.message);
    ouvirEventos((evento) => {
      if (evento === 'mesas') mostrarEscolhaDeMesa();
    });
    return;
  }

  document.getElementById('telaMesa').hidden = false;

  // Confirma em que mesa a pessoa está e quem ela é, antes de qualquer pedido.
  estado.nome = lerNomeSalvo(numero);
  if (!estado.nome) {
    document.getElementById('mesaGigante').textContent = String(numero).padStart(2, '0');
    document.getElementById('campoNome').value = ultimoNomeUsado();
    abrirModal('modalNome');
    setTimeout(() => document.getElementById('campoNome').select(), 120);
  }
  desenharCartao();

  document.getElementById('formNome').addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = document.getElementById('campoNome').value.trim().slice(0, 40);
    if (!nome) {
      document.getElementById('erroNome').innerHTML =
        `<div class="aviso aviso-erro" style="margin-top:12px">Escreva um nome para o garçom te chamar.</div>`;
      return;
    }
    estado.nome = nome;
    salvarNome(numero, nome);
    fecharModal('modalNome');
    desenharCartao();
    torrada(`Bem-vindo(a), ${nome}! Você está na mesa ${numero}.`);
  });

  document.querySelectorAll('.aba[data-painel]').forEach((b) =>
    b.addEventListener('click', () => trocarPainel(b.dataset.painel))
  );
  document.getElementById('btnRevisar').addEventListener('click', abrirRevisao);
  document.getElementById('btnLimpar').addEventListener('click', limparCarrinho);
  document.getElementById('btnEnviar').addEventListener('click', enviarPedido);
  document.getElementById('btnPedirRecarga').addEventListener('click', abrirRecarga);
  document.getElementById('btnEnviarRecarga').addEventListener('click', pedirRecarga);
  document.getElementById('recargaOutro').addEventListener('input', () => {
    estado.valorRecarga = null;
    desenharValoresRecarga();
  });

  // O garçom recarregou o cartão ou mexeu num pedido? A tela se atualiza sozinha.
  ouvirEventos((evento, dados) => {
    if (evento === 'cardapio') return carregar(numero).catch(() => {});
    if (dados.mesa && dados.mesa !== numero) return;
    recarregarMesa().catch(() => {});
  });
}

iniciar();
