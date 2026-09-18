'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const agora = () => new Date().toISOString();

// ------------------------------------------------------------- SSE (tempo real)

const clientesSSE = new Set();

function avisar(evento, dados = {}) {
  const payload = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of clientesSSE) {
    try {
      res.write(payload);
    } catch {
      clientesSSE.delete(res);
    }
  }
}

// ------------------------------------------------------------------- utilidades

function json(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(texto);
}

function erro(res, status, mensagem) {
  json(res, status, { erro: mensagem });
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    req.on('data', (p) => {
      bruto += p;
      if (bruto.length > 1e6) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!bruto) return resolve({});
      try {
        resolve(JSON.parse(bruto));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function garcomDaRequisicao(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT g.id, g.nome FROM sessoes s
         JOIN garcons g ON g.id = s.garcom_id
         WHERE s.token = ?`
      )
      .get(token) || null
  );
}

const inteiro = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

// O nome é só para o garçom saber quem chamou — texto curto, sem exigir nada.
const nomeDoCliente = (v) => String(v || '').trim().slice(0, 40);

// -------------------------------------------------------------- consultas base

// Quanto a mesa já consumiu na sessão atual (desde que foi aberta),
// descontando os estornos de pedidos cancelados.
const SQL_CONSUMO = `(
  SELECT COALESCE(SUM(-t.valor), 0) FROM transacoes t
   WHERE t.mesa = m.numero
     AND t.tipo IN ('consumo', 'estorno')
     AND (m.aberta_em IS NULL OR t.criado_em >= m.aberta_em)
)`;

function listarMesas() {
  return db
    .prepare(
      `SELECT m.numero, m.apelido, m.lugares, m.status, m.saldo, m.aberta_em,
              g.nome AS garcom,
              (SELECT COUNT(*) FROM pedidos p
                WHERE p.mesa = m.numero
                  AND p.status IN ('recebido','preparando','pronto')) AS pedidos_abertos,
              ${SQL_CONSUMO} AS consumo,
              (SELECT COALESCE(SUM(r.valor), 0) FROM recargas r
                WHERE r.mesa = m.numero AND r.status = 'pendente') AS recarga_pendente
         FROM mesas m
         LEFT JOIN garcons g ON g.id = m.garcom_id
        ORDER BY m.numero`
    )
    .all();
}

function buscarMesa(numero) {
  return db
    .prepare(
      `SELECT m.numero, m.apelido, m.lugares, m.status, m.saldo, m.aberta_em,
              g.nome AS garcom,
              ${SQL_CONSUMO} AS consumo
         FROM mesas m
         LEFT JOIN garcons g ON g.id = m.garcom_id
        WHERE m.numero = ?`
    )
    .get(numero);
}

function itensDoPedido(pedidoId) {
  return db
    .prepare(
      'SELECT id, item_id, nome, emoji, preco_unit, qtd FROM pedido_itens WHERE pedido_id = ? ORDER BY id'
    )
    .all(pedidoId);
}

function listarPedidos({ mesa = null, ativos = false, limite = 100 } = {}) {
  const cond = [];
  const args = [];
  if (mesa !== null) {
    cond.push('p.mesa = ?');
    args.push(mesa);
  }
  if (ativos) cond.push("p.status IN ('recebido','preparando','pronto')");
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const pedidos = db
    .prepare(
      `SELECT p.id, p.mesa, p.status, p.total, p.observacao, p.cliente_nome,
              p.origem, p.criado_em, p.atualizado_em
         FROM pedidos p ${where}
        ORDER BY p.id DESC LIMIT ?`
    )
    .all(...args, limite);
  for (const p of pedidos) p.itens = itensDoPedido(p.id);
  return pedidos;
}

const LIMITE_RECARGA = 500000; // R$ 5.000,00 por recarga

function recargasPendentes(mesa = null) {
  return db
    .prepare(
      `SELECT r.id, r.mesa, r.valor, r.forma_pgto, r.cliente_nome, r.criado_em
         FROM recargas r
        WHERE r.status = 'pendente' ${mesa !== null ? 'AND r.mesa = ?' : ''}
        ORDER BY r.id`
    )
    .all(...(mesa !== null ? [mesa] : []));
}

function extratoDaMesa(mesa, limite = 60) {
  return db
    .prepare(
      `SELECT t.id, t.tipo, t.valor, t.saldo_apos, t.descricao, t.forma_pgto,
              t.pedido_id, t.criado_em, g.nome AS garcom
         FROM transacoes t
         LEFT JOIN garcons g ON g.id = t.garcom_id
        WHERE t.mesa = ?
        ORDER BY t.id DESC LIMIT ?`
    )
    .all(mesa, limite);
}

function registrarTransacao({
  mesa,
  tipo,
  valor,
  descricao = '',
  forma_pgto = null,
  pedido_id = null,
  garcom_id = null,
}) {
  const atual = db.prepare('SELECT saldo FROM mesas WHERE numero = ?').get(mesa);
  if (!atual) throw new Error('mesa inexistente');
  const novoSaldo = atual.saldo + valor;
  db.prepare('UPDATE mesas SET saldo = ? WHERE numero = ?').run(novoSaldo, mesa);
  db.prepare(
    `INSERT INTO transacoes (mesa, tipo, valor, saldo_apos, descricao, forma_pgto, pedido_id, garcom_id, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(mesa, tipo, valor, novoSaldo, descricao, forma_pgto, pedido_id, garcom_id, agora());
  return novoSaldo;
}

// ------------------------------------------------------------------ rotas API

const STATUS_PEDIDO = ['recebido', 'preparando', 'pronto', 'entregue', 'cancelado'];

async function api(req, res, url) {
  const rota = url.pathname.replace(/^\/api/, '');
  const metodo = req.method;
  const corpo = metodo === 'POST' || metodo === 'PATCH' ? await lerCorpo(req) : {};

  // ---- login do garçom
  if (rota === '/login' && metodo === 'POST') {
    const pin = String(corpo.pin || '').trim();
    const garcom = db
      .prepare('SELECT id, nome FROM garcons WHERE pin = ? AND ativo = 1')
      .get(pin);
    if (!garcom) return erro(res, 401, 'PIN inválido');
    const token = crypto.randomUUID();
    db.prepare('INSERT INTO sessoes (token, garcom_id, criado_em) VALUES (?, ?, ?)').run(
      token,
      garcom.id,
      agora()
    );
    return json(res, 200, { token, garcom });
  }

  if (rota === '/eu' && metodo === 'GET') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'sessão expirada');
    return json(res, 200, { garcom: g });
  }

  if (rota === '/logout' && metodo === 'POST') {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      db.prepare('DELETE FROM sessoes WHERE token = ?').run(header.slice(7));
    }
    return json(res, 200, { ok: true });
  }

  // ---- cardápio (público para leitura)
  if (rota === '/cardapio' && metodo === 'GET') {
    const todos = url.searchParams.get('todos') === '1';
    const itens = db
      .prepare(
        `SELECT id, nome, descricao, categoria, preco, emoji, disponivel
           FROM cardapio ${todos ? '' : 'WHERE disponivel = 1'}
          ORDER BY ordem, id`
      )
      .all();
    return json(res, 200, { itens });
  }

  if (rota === '/cardapio' && metodo === 'POST') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    const nome = String(corpo.nome || '').trim();
    const preco = inteiro(corpo.preco);
    if (!nome) return erro(res, 400, 'informe o nome do item');
    if (!Number.isFinite(preco) || preco <= 0) return erro(res, 400, 'preço inválido');
    const info = db
      .prepare(
        `INSERT INTO cardapio (nome, descricao, categoria, preco, emoji, ordem)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        nome,
        String(corpo.descricao || ''),
        String(corpo.categoria || 'Outros').trim() || 'Outros',
        preco,
        String(corpo.emoji || '🍜'),
        999
      );
    avisar('cardapio', {});
    return json(res, 201, { id: Number(info.lastInsertRowid) });
  }

  // ---- disponibilidade de um item
  let m;
  if ((m = rota.match(/^\/cardapio\/(\d+)$/)) && metodo === 'PATCH') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    const id = Number(m[1]);
    const item = db.prepare('SELECT id FROM cardapio WHERE id = ?').get(id);
    if (!item) return erro(res, 404, 'item não encontrado');
    if ('disponivel' in corpo) {
      db.prepare('UPDATE cardapio SET disponivel = ? WHERE id = ?').run(
        corpo.disponivel ? 1 : 0,
        id
      );
    }
    if ('preco' in corpo) {
      const preco = inteiro(corpo.preco);
      if (!Number.isFinite(preco) || preco <= 0) return erro(res, 400, 'preço inválido');
      db.prepare('UPDATE cardapio SET preco = ? WHERE id = ?').run(preco, id);
    }
    avisar('cardapio', { id });
    return json(res, 200, { ok: true });
  }

  // ---- mesas
  if (rota === '/mesas' && metodo === 'GET') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    return json(res, 200, { mesas: listarMesas() });
  }

  // Versão enxuta para o cliente escolher a mesa: sem saldos nem consumo.
  if (rota === '/mesas-abertas' && metodo === 'GET') {
    const mesas = db
      .prepare(
        `SELECT numero, apelido, lugares, status
           FROM mesas ORDER BY numero`
      )
      .all();
    return json(res, 200, { mesas });
  }

  if (rota === '/mesas' && metodo === 'POST') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    const numero = inteiro(corpo.numero);
    if (!Number.isFinite(numero) || numero <= 0) return erro(res, 400, 'número inválido');
    if (db.prepare('SELECT numero FROM mesas WHERE numero = ?').get(numero))
      return erro(res, 409, `a mesa ${numero} já existe`);
    db.prepare('INSERT INTO mesas (numero, lugares, apelido) VALUES (?, ?, ?)').run(
      numero,
      inteiro(corpo.lugares) || 4,
      String(corpo.apelido || '') || null
    );
    avisar('mesas', { numero });
    return json(res, 201, { mesa: buscarMesa(numero) });
  }

  if ((m = rota.match(/^\/mesas\/(\d+)$/)) && metodo === 'GET') {
    const numero = Number(m[1]);
    const mesa = buscarMesa(numero);
    if (!mesa) return erro(res, 404, `a mesa/cartão ${numero} não existe`);
    return json(res, 200, {
      mesa,
      pedidos: listarPedidos({ mesa: numero, limite: 30 }),
      extrato: extratoDaMesa(numero),
      recarga_pendente: recargasPendentes(numero)[0] || null,
    });
  }

  if ((m = rota.match(/^\/mesas\/(\d+)\/abrir$/)) && metodo === 'POST') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    const numero = Number(m[1]);
    const mesa = buscarMesa(numero);
    if (!mesa) return erro(res, 404, 'mesa não encontrada');
    if (mesa.status === 'ocupada') return erro(res, 409, 'esta mesa já está aberta');
    db.prepare(
      "UPDATE mesas SET status = 'ocupada', aberta_em = ?, garcom_id = ? WHERE numero = ?"
    ).run(agora(), g.id, numero);
    avisar('mesas', { numero });
    return json(res, 200, { mesa: buscarMesa(numero) });
  }

  if ((m = rota.match(/^\/mesas\/(\d+)\/fechar$/)) && metodo === 'POST') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    const numero = Number(m[1]);
    const mesa = buscarMesa(numero);
    if (!mesa) return erro(res, 404, 'mesa não encontrada');

    const abertos = db
      .prepare(
        "SELECT COUNT(*) AS n FROM pedidos WHERE mesa = ? AND status IN ('recebido','preparando','pronto')"
      )
      .get(numero).n;
    if (abertos && !corpo.forcar)
      return erro(res, 409, `ainda há ${abertos} pedido(s) em aberto nesta mesa`);

    let devolvido = 0;
    if (mesa.saldo > 0) {
      devolvido = mesa.saldo;
      registrarTransacao({
        mesa: numero,
        tipo: 'devolucao',
        valor: -mesa.saldo,
        descricao: 'Saldo devolvido no fechamento da mesa',
        garcom_id: g.id,
      });
    }
    db.prepare(
      "UPDATE mesas SET status = 'livre', aberta_em = NULL, garcom_id = NULL WHERE numero = ?"
    ).run(numero);
    avisar('mesas', { numero });
    return json(res, 200, { mesa: buscarMesa(numero), devolvido });
  }

  // ---- o cliente pede a recarga pela própria mesa; o garçom libera depois
  if ((m = rota.match(/^\/mesas\/(\d+)\/recarga-pedido$/)) && metodo === 'POST') {
    const numero = Number(m[1]);
    const mesa = buscarMesa(numero);
    if (!mesa) return erro(res, 404, 'cartão/mesa não encontrado');
    // O garçom abre a mesa primeiro; só depois o cliente recarrega.
    if (mesa.status !== 'ocupada')
      return erro(res, 409, 'esta mesa ainda não foi aberta pelo garçom');

    const valor = inteiro(corpo.valor);
    if (!Number.isFinite(valor) || valor <= 0) return erro(res, 400, 'valor de recarga inválido');
    if (valor > LIMITE_RECARGA)
      return erro(res, 400, 'valor acima do limite por recarga (R$ 5.000,00)');

    // Uma pendência por vez evita fila de pedidos repetidos para o garçom.
    if (recargasPendentes(numero).length)
      return erro(res, 409, 'já existe uma recarga aguardando o garçom nesta mesa');

    const formas = ['dinheiro', 'pix', 'débito', 'crédito'];
    const forma = String(corpo.forma_pgto || 'dinheiro');
    if (!formas.includes(forma)) return erro(res, 400, 'forma de pagamento inválida');

    const info = db
      .prepare(
        `INSERT INTO recargas (mesa, valor, forma_pgto, cliente_nome, status, criado_em)
         VALUES (?, ?, ?, ?, 'pendente', ?)`
      )
      .run(numero, valor, forma, nomeDoCliente(corpo.cliente_nome), agora());

    avisar('recargas', { mesa: numero, recarga: Number(info.lastInsertRowid) });
    return json(res, 201, { recarga: recargasPendentes(numero)[0] });
  }

  // O cliente pode desistir enquanto o garçom não decidiu.
  if ((m = rota.match(/^\/recargas\/(\d+)\/cancelar$/)) && metodo === 'POST') {
    const id = Number(m[1]);
    const pedido = db.prepare('SELECT * FROM recargas WHERE id = ?').get(id);
    if (!pedido) return erro(res, 404, 'pedido de recarga não encontrado');
    if (pedido.status !== 'pendente') return erro(res, 409, 'este pedido já foi decidido');

    db.prepare("UPDATE recargas SET status = 'cancelada', decidido_em = ? WHERE id = ?").run(
      agora(),
      id
    );
    avisar('recargas', { mesa: pedido.mesa, recarga: id });
    return json(res, 200, { ok: true });
  }

  if (rota === '/recargas' && metodo === 'GET') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    return json(res, 200, { recargas: recargasPendentes() });
  }

  if ((m = rota.match(/^\/recargas\/(\d+)\/(liberar|recusar)$/)) && metodo === 'POST') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    const id = Number(m[1]);
    const acao = m[2];

    const pedido = db.prepare('SELECT * FROM recargas WHERE id = ?').get(id);
    if (!pedido) return erro(res, 404, 'pedido de recarga não encontrado');
    if (pedido.status !== 'pendente') return erro(res, 409, 'este pedido já foi decidido');

    if (acao === 'recusar') {
      db.prepare(
        "UPDATE recargas SET status = 'recusada', decidido_em = ?, garcom_id = ? WHERE id = ?"
      ).run(agora(), g.id, id);
      avisar('recargas', { mesa: pedido.mesa, recarga: id });
      return json(res, 200, { ok: true });
    }

    // Liberar é o momento em que o dinheiro entra no cartão.
    const saldo = registrarTransacao({
      mesa: pedido.mesa,
      tipo: 'recarga',
      valor: pedido.valor,
      descricao: 'Recarga pedida na mesa e liberada pelo garçom',
      forma_pgto: pedido.forma_pgto,
      garcom_id: g.id,
    });
    db.prepare(
      "UPDATE recargas SET status = 'liberada', decidido_em = ?, garcom_id = ? WHERE id = ?"
    ).run(agora(), g.id, id);

    avisar('recargas', { mesa: pedido.mesa, recarga: id });
    avisar('mesas', { numero: pedido.mesa });
    avisar('saldo', { mesa: pedido.mesa, saldo });
    return json(res, 200, { saldo, mesa: buscarMesa(pedido.mesa) });
  }

  // ---- recarga lançada direto pelo garçom (cliente sem celular, ajuste manual)
  if ((m = rota.match(/^\/mesas\/(\d+)\/recarga$/)) && metodo === 'POST') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    const numero = Number(m[1]);
    const mesa = buscarMesa(numero);
    if (!mesa) return erro(res, 404, 'mesa não encontrada');
    const valor = inteiro(corpo.valor);
    if (!Number.isFinite(valor) || valor <= 0) return erro(res, 400, 'valor de recarga inválido');
    if (valor > LIMITE_RECARGA)
      return erro(res, 400, 'valor acima do limite por recarga (R$ 5.000,00)');

    // Recarregar abre a mesa automaticamente, se ainda estiver livre.
    if (mesa.status === 'livre') {
      db.prepare(
        "UPDATE mesas SET status = 'ocupada', aberta_em = ?, garcom_id = ? WHERE numero = ?"
      ).run(agora(), g.id, numero);
    }
    const saldo = registrarTransacao({
      mesa: numero,
      tipo: 'recarga',
      valor,
      descricao: 'Recarga no cartão da mesa',
      forma_pgto: String(corpo.forma_pgto || 'dinheiro'),
      garcom_id: g.id,
    });
    avisar('mesas', { numero });
    avisar('saldo', { mesa: numero, saldo });
    return json(res, 200, { mesa: buscarMesa(numero), saldo });
  }

  // ---- pedidos
  if (rota === '/pedidos' && metodo === 'GET') {
    const mesa = url.searchParams.get('mesa');
    return json(res, 200, {
      pedidos: listarPedidos({
        mesa: mesa ? Number(mesa) : null,
        ativos: url.searchParams.get('ativos') === '1',
        limite: Number(url.searchParams.get('limite')) || 100,
      }),
    });
  }

  if (rota === '/pedidos' && metodo === 'POST') {
    const numero = inteiro(corpo.mesa);
    const mesa = buscarMesa(numero);
    if (!mesa) return erro(res, 404, 'cartão/mesa não encontrado');
    if (mesa.status !== 'ocupada')
      return erro(res, 409, 'esta mesa ainda não foi aberta — chame o garçom');

    const linhas = Array.isArray(corpo.itens) ? corpo.itens : [];
    if (!linhas.length) return erro(res, 400, 'o pedido está vazio');

    const preparados = [];
    let total = 0;
    for (const linha of linhas) {
      const item = db
        .prepare('SELECT id, nome, emoji, preco, disponivel FROM cardapio WHERE id = ?')
        .get(inteiro(linha.item_id));
      if (!item) return erro(res, 400, 'item inexistente no cardápio');
      if (!item.disponivel) return erro(res, 409, `${item.nome} não está disponível agora`);
      const qtd = inteiro(linha.qtd);
      if (!Number.isFinite(qtd) || qtd <= 0 || qtd > 50)
        return erro(res, 400, `quantidade inválida para ${item.nome}`);
      total += item.preco * qtd;
      preparados.push({ item, qtd });
    }

    if (total > mesa.saldo) {
      return json(res, 402, {
        erro: 'saldo insuficiente no cartão da mesa',
        saldo: mesa.saldo,
        total,
        falta: total - mesa.saldo,
      });
    }

    const ts = agora();
    const origem = garcomDaRequisicao(req) ? 'garcom' : 'cliente';
    const info = db
      .prepare(
        `INSERT INTO pedidos (mesa, status, total, observacao, cliente_nome, origem, criado_em, atualizado_em)
         VALUES (?, 'recebido', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        numero,
        total,
        String(corpo.observacao || '').slice(0, 300),
        nomeDoCliente(corpo.cliente_nome),
        origem,
        ts,
        ts
      );
    const pedidoId = Number(info.lastInsertRowid);

    const insItem = db.prepare(
      `INSERT INTO pedido_itens (pedido_id, item_id, nome, emoji, preco_unit, qtd)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const { item, qtd } of preparados) {
      insItem.run(pedidoId, item.id, item.nome, item.emoji, item.preco, qtd);
    }

    const saldo = registrarTransacao({
      mesa: numero,
      tipo: 'consumo',
      valor: -total,
      descricao: `Pedido #${pedidoId}`,
      pedido_id: pedidoId,
    });

    avisar('pedidos', { mesa: numero, pedido: pedidoId });
    avisar('saldo', { mesa: numero, saldo });
    return json(res, 201, {
      pedido: listarPedidos({ mesa: numero, limite: 1 })[0],
      saldo,
    });
  }

  if ((m = rota.match(/^\/pedidos\/(\d+)\/status$/)) && metodo === 'PATCH') {
    const g = garcomDaRequisicao(req);
    if (!g) return erro(res, 401, 'faça login');
    const id = Number(m[1]);
    const status = String(corpo.status || '');
    if (!STATUS_PEDIDO.includes(status)) return erro(res, 400, 'status inválido');

    const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
    if (!pedido) return erro(res, 404, 'pedido não encontrado');
    if (pedido.status === status) return json(res, 200, { ok: true });
    if (pedido.status === 'cancelado') return erro(res, 409, 'este pedido já foi cancelado');

    db.prepare('UPDATE pedidos SET status = ?, atualizado_em = ? WHERE id = ?').run(
      status,
      agora(),
      id
    );

    let saldo = null;
    if (status === 'cancelado') {
      saldo = registrarTransacao({
        mesa: pedido.mesa,
        tipo: 'estorno',
        valor: pedido.total,
        descricao: `Estorno do pedido #${id}`,
        pedido_id: id,
        garcom_id: g.id,
      });
      avisar('saldo', { mesa: pedido.mesa, saldo });
    }
    avisar('pedidos', { mesa: pedido.mesa, pedido: id });
    return json(res, 200, { ok: true, saldo });
  }

  // ---- visão geral do salão
  if (rota === '/resumo' && metodo === 'GET') {
    const mesas = listarMesas();
    const hoje = new Date().toISOString().slice(0, 10);
    const caixa = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN tipo = 'recarga'   THEN valor END), 0) AS recargas,
           COALESCE(SUM(CASE WHEN tipo = 'devolucao' THEN -valor END), 0) AS devolucoes,
           -- consumo já descontado dos estornos de pedidos cancelados
           COALESCE(SUM(CASE WHEN tipo IN ('consumo','estorno') THEN -valor END), 0) AS consumo
         FROM transacoes WHERE substr(criado_em, 1, 10) = ?`
      )
      .get(hoje);
    return json(res, 200, {
      mesas_ocupadas: mesas.filter((x) => x.status === 'ocupada').length,
      mesas_total: mesas.length,
      saldo_em_cartoes: mesas.reduce((s, x) => s + x.saldo, 0),
      pedidos_ativos: db
        .prepare(
          "SELECT COUNT(*) AS n FROM pedidos WHERE status IN ('recebido','preparando','pronto')"
        )
        .get().n,
      recargas_pendentes: recargasPendentes().length,
      caixa,
    });
  }

  return erro(res, 404, 'rota não encontrada');
}

// ------------------------------------------------------------ arquivos estáticos

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function servirEstatico(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (!path.extname(rel)) rel += '.html';

  const destino = path.join(PUBLIC_DIR, rel);
  if (!destino.startsWith(PUBLIC_DIR)) return erro(res, 403, 'acesso negado');

  fs.readFile(destino, (err, dados) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1><p>Página não encontrada. <a href="/">Voltar</a></p>');
    }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(destino)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(dados);
  });
}

// -------------------------------------------------------------------- servidor

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clientesSSE.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clientesSSE.delete(res);
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await api(req, res, url);
    } catch (e) {
      console.error('[erro]', e);
      if (!res.headersSent) erro(res, 500, e.message || 'erro interno');
    }
    return;
  }

  servirEstatico(req, res, url);
});

servidor.listen(PORT, () => {
  console.log(`
  🍜  Sistema do restaurante no ar

      Portal .......... http://localhost:${PORT}/
      Garçom .......... http://localhost:${PORT}/garcom
      Cliente (mesa 1)  http://localhost:${PORT}/cliente?mesa=1

      PINs de garçom: 1234 (Ester) · 4321 (Lucas)
      Banco de dados: data/restaurante.db
`);
});
