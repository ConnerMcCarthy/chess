import { Chess, DEFAULT_POSITION } from './vendor/chess.js';

const STORAGE_KEY = 'hill-lab-games-v1';
const ENGINE_NOTE = 'Evaluations use King of the Hill rules. Positive scores favor White; negative scores favor Black.';
const HILL_SQUARES = new Set(['d4', 'e4', 'd5', 'e5']);
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];
const PIECES = {
  wp: 'wP', wn: 'wN', wb: 'wB', wr: 'wR', wq: 'wQ', wk: 'wK',
  bp: 'bP', bn: 'bN', bb: 'bB', br: 'bR', bq: 'bQ', bk: 'bK',
};

const EXAMPLE_PGN = `[Event "First to the Hill"]
[Site "Hill Lab"]
[Date "2026.09.29"]
[Round "1"]
[White "Center Runner"]
[Black "Queenside Pusher"]
[Result "1-0"]
[Variant "King of the Hill"]

1. e4 a6 2. Ke2 a5 3. e5 a4 4. Ke3 h6 5. Ke4 1-0`;

const els = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [element.id, element]),
);

const state = {
  orientation: 'w',
  positions: [{ fen: DEFAULT_POSITION, move: null }],
  currentIndex: 0,
  headers: {},
  pgn: '',
  savedId: null,
  analyses: {},
  savedGames: readSavedGames(),
  engineReady: false,
  analyzing: false,
  cancelRequested: false,
  selectedSquare: null,
  legalMoves: [],
  showArrows: localStorage.getItem('hill-lab-show-arrows') !== 'false',
  lineCount: Math.max(1, Math.min(3, Number(localStorage.getItem('hill-lab-line-count')) || 1)),
  preview: null,
};

class KothEngine {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.engine = null;
    this.waiters = [];
    this.initializing = null;
    this.cache = new Map();
    const logicalCores = navigator.hardwareConcurrency || 2;
    const deviceMemory = navigator.deviceMemory || 4;
    this.threads = Math.min(4, Math.max(1, logicalCores - 1));
    this.hash = deviceMemory >= 8 ? 128 : deviceMemory >= 4 ? 96 : 64;
    this.readyText = `KOTH engine ready · ${this.threads}T · ${this.hash} MB`;
  }

  async init() {
    if (this.engine) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        throw new Error('Engine headers are missing. Open this app through its local server.');
      }
      if (typeof window.Stockfish !== 'function') {
        throw new Error('Fairy-Stockfish could not be loaded.');
      }

      this.onStatus('loading', 'Starting KOTH engine');
      this.engine = await window.Stockfish();
      this.engine.addMessageListener((message) => this.handleMessage(String(message)));
      this.send('uci');
      await this.waitFor((line) => line === 'uciok', 20000);
      this.send('setoption name UCI_Variant value kingofthehill');
      this.send(`setoption name Threads value ${this.threads}`);
      this.send(`setoption name Hash value ${this.hash}`);
      this.send('setoption name UCI_AnalyseMode value true');
      this.send('isready');
      await this.waitFor((line) => line === 'readyok', 20000);
      this.onStatus('ready', this.readyText);
    })();

    try {
      await this.initializing;
    } catch (error) {
      this.engine = null;
      this.initializing = null;
      this.onStatus('error', 'Engine unavailable');
      throw error;
    }
  }

  send(command) {
    this.engine?.postMessage(command);
  }

  handleMessage(line) {
    for (const waiter of [...this.waiters]) {
      waiter.observe(line);
    }
  }

  waitFor(predicate, timeout = 30000, timeoutCode = 'ENGINE_TIMEOUT') {
    return new Promise((resolve, reject) => {
      const waiter = {
        observe: (line) => {
          if (!predicate(line)) return;
          clearTimeout(timer);
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          resolve(line);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        const error = new Error(
          timeoutCode === 'ANALYSIS_TIMEOUT'
            ? 'Analysis exceeded the 10-minute search limit.'
            : 'The engine did not respond in time.',
        );
        error.code = timeoutCode;
        reject(error);
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  async analyze(fen, depth, multiPv = 1, onUpdate = null) {
    const cacheKey = `${multiPv}:${fen}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.depth >= depth) return { ...cached, cached: true };

    await this.init();
    const latestLines = new Map();
    const infoListener = {
      observe: (line) => {
        const parsed = parseInfoLine(line, fen);
        if (!parsed || parsed.multiPv > multiPv) return;
        const previous = latestLines.get(parsed.multiPv);
        if (!previous || parsed.depth >= previous.depth) latestLines.set(parsed.multiPv, parsed);
        if (onUpdate) onUpdate(buildAnalysisResult(latestLines, multiPv));
      },
    };
    this.waiters.push(infoListener);

    try {
      this.send(`setoption name MultiPV value ${multiPv}`);
      this.send('position fen ' + fen);
      this.send('go depth ' + depth);
      const bestMoveLine = await this.waitFor(
        (line) => line.startsWith('bestmove '),
        600000,
        'ANALYSIS_TIMEOUT',
      );
      const bestMove = bestMoveLine.split(/\s+/)[1];
      const result = {
        ...buildAnalysisResult(latestLines, multiPv),
        bestMove,
      };
      this.cache.set(cacheKey, result);
      if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
      return result;
    } finally {
      this.waiters = this.waiters.filter((candidate) => candidate !== infoListener);
    }
  }

  stop() {
    this.send('stop');
  }
}

const engine = new KothEngine(setEngineStatus);

function parseInfoLine(line, fen) {
  if (!line.startsWith('info ') || !line.includes(' score ')) return null;
  const depthMatch = line.match(/\bdepth (\d+)/);
  const multiPvMatch = line.match(/\bmultipv (\d+)/);
  const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/);
  if (!scoreMatch) return null;

  const sideToMove = fen.split(' ')[1];
  const perspective = sideToMove === 'w' ? 1 : -1;
  const rawValue = Number(scoreMatch[2]);
  const isMate = scoreMatch[1] === 'mate';
  const pvIndex = line.indexOf(' pv ');

  return {
    multiPv: Number(multiPvMatch?.[1] || 1),
    depth: Number(depthMatch?.[1] || 0),
    score: isMate ? Math.sign(rawValue || 1) * 100 * perspective : (rawValue / 100) * perspective,
    mate: isMate ? rawValue * perspective : null,
    pv: pvIndex >= 0 ? line.slice(pvIndex + 4).trim().split(/\s+/) : [],
  };
}

function buildAnalysisResult(latestLines, requestedLines) {
  const lines = [...latestLines.values()].sort((a, b) => a.multiPv - b.multiPv);
  const primary = lines[0] || { depth: 0, score: 0, mate: null, pv: [] };
  return {
    ...primary,
    lines,
    multiPv: requestedLines,
  };
}

function parsePgn(pgn) {
  const tagHeaders = parseTagHeaders(pgn);
  if (isChessComTwoPlayerPgn(tagHeaders)) {
    return parseChessComTwoPlayerPgn(pgn, tagHeaders);
  }

  const parsed = new Chess();
  parsed.loadPgn(pgn, { strict: false });
  const headers = parsed.getHeaders();
  const verboseMoves = parsed.history({ verbose: true });
  const startFen = headers.FEN || DEFAULT_POSITION;
  const replay = new Chess(startFen);
  const positions = [{ fen: startFen, move: null }];

  for (const move of verboseMoves) {
    const applied = replay.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
    });
    if (!applied) throw new Error('A move in this PGN could not be replayed.');
    positions.push({
      fen: replay.fen(),
      move: {
        from: move.from,
        to: move.to,
        san: move.san,
        color: move.color,
      },
    });
  }

  return { headers, positions, pgn };
}

function parseTagHeaders(pgn) {
  const headers = {};
  const tagPattern = /^\s*\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"\\])*)"\]\s*$/gm;
  let match;
  while ((match = tagPattern.exec(pgn)) !== null) {
    headers[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return headers;
}

function isChessComTwoPlayerPgn(headers) {
  return headers.StartFen4 === '2PC';
}

function parseChessComTwoPlayerPgn(pgn, rawHeaders) {
  const headers = { ...rawHeaders };
  headers.SourceVariant = headers.Variant || 'FFA';
  if (/\bKotH\b/i.test(headers.RuleVariants || '')) headers.Variant = 'King of the Hill';
  headers.Event ||= headers.GameNr ? `Chess.com game ${headers.GameNr}` : 'Chess.com variants game';

  const replay = new Chess(DEFAULT_POSITION);
  const positions = [{ fen: DEFAULT_POSITION, move: null }];
  const moveText = pgn
    .replace(/^\s*\[[^\r\n]*\]\s*$/gm, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;[^\r\n]*/g, ' ')
    .replace(/\d+\.(?:\.\.)?/g, ' ');
  const tokens = moveText.split(/\s+/).filter(Boolean);
  let ply = 0;

  for (const token of tokens) {
    if (token === '..' || token === 'e.p.' || /^\$\d+$/.test(token) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) {
      continue;
    }
    if (token.startsWith('(') || token.endsWith(')')) {
      throw new Error('Chess.com PGN variations are not supported yet.');
    }

    const move = normalizeChessComMove(token);
    if (!move) throw new Error(`Unsupported Chess.com move notation: ${token}`);

    let applied;
    try {
      applied = replay.move(move);
    } catch {
      applied = null;
    }
    if (!applied) {
      const moveNumber = Math.floor(ply / 2) + 1;
      const suffix = ply % 2 === 0 ? '.' : '...';
      throw new Error(`Illegal translated move at ${moveNumber}${suffix}: ${token}`);
    }

    positions.push({
      fen: replay.fen(),
      move: {
        from: applied.from,
        to: applied.to,
        san: applied.san,
        color: applied.color,
        source: token,
      },
    });
    ply += 1;
  }

  if (ply === 0) throw new Error('No Chess.com moves were found.');
  return { headers, positions, pgn };
}

function normalizeChessComMove(token) {
  const match = token.match(
    /^([KQRBNP]?)([d-k])(1[01]|[4-9])[-x](?:[KQRBNP])?([d-k])(1[01]|[4-9])(?:=([QRBN]))?[+#?!]*$/,
  );
  if (!match) return null;

  return {
    from: translateChessComSquare(match[2], match[3]),
    to: translateChessComSquare(match[4], match[5]),
    promotion: match[6]?.toLowerCase(),
  };
}

function translateChessComSquare(file, rank) {
  const normalizedFile = String.fromCharCode('a'.charCodeAt(0) + file.charCodeAt(0) - 'd'.charCodeAt(0));
  return normalizedFile + (Number(rank) - 3);
}

function loadGame(game, options = {}) {
  stopAnalysis();
  clearBoardSelection();
  state.preview = null;
  state.headers = game.headers || {};
  state.positions = game.positions || [{ fen: DEFAULT_POSITION, move: null }];
  state.pgn = game.pgn || '';
  state.currentIndex = options.atStart ? 0 : state.positions.length - 1;
  state.savedId = game.id || null;
  state.analyses = game.analyses || {};
  renderAll();
}

function resetWorkspace() {
  loadGame({
    headers: {},
    positions: [{ fen: DEFAULT_POSITION, move: null }],
    pgn: '',
    analyses: {},
  });
  openImportDialog();
}

function renderAll() {
  renderBoard();
  renderGameHeading();
  renderMoveList();
  renderAnalysis();
  renderLibrary();
  updateNavigation();
  els['save-state'].textContent = state.savedId ? 'Saved locally' : 'Not saved';
}

function displayedFen() {
  return state.preview?.fen || state.positions[state.currentIndex].fen;
}

function renderBoard() {
  const chess = new Chess(displayedFen());
  const files = state.orientation === 'w' ? FILES : [...FILES].reverse();
  const ranks = state.orientation === 'w' ? RANKS : [...RANKS].reverse();
  const lastMove = state.preview?.move || state.positions[state.currentIndex].move;
  const checkedKing = chess.inCheck() ? findKing(chess, chess.turn()) : null;
  const winner = hillWinner(chess);
  const fragment = document.createDocumentFragment();

  ranks.forEach((rank, rankIndex) => {
    files.forEach((file, fileIndex) => {
      const squareName = file + rank;
      const square = document.createElement('div');
      const isLight = (FILES.indexOf(file) + Number(rank)) % 2 === 1;
      square.className = 'square ' + (isLight ? 'light' : 'dark');
      square.dataset.square = squareName;
      square.setAttribute('role', 'gridcell');
      square.setAttribute('aria-label', squareName);
      if (state.selectedSquare === squareName) square.classList.add('selected');
      const legalMove = state.legalMoves.find((move) => move.to === squareName);
      if (legalMove) square.classList.add(legalMove.captured ? 'legal-capture' : 'legal-target');
      if (HILL_SQUARES.has(squareName)) square.classList.add('hill');
      if (lastMove && (lastMove.from === squareName || lastMove.to === squareName)) {
        square.classList.add('last-move');
      }
      if (checkedKing === squareName) square.classList.add('check');
      if (winner?.square === squareName) square.classList.add('hill-winner');

      const piece = chess.get(squareName);
      if (piece) {
        const isPlayable = !winner && !state.analyzing && piece.color === chess.turn();
        if (isPlayable) {
          square.classList.add('playable');
        }
        const pieceElement = document.createElement('img');
        pieceElement.className = 'piece';
        pieceElement.src = `assets/pieces/cburnett/${PIECES[piece.color + piece.type]}.svg`;
        pieceElement.alt = '';
        pieceElement.draggable = isPlayable;
        square.append(pieceElement);
        square.setAttribute('aria-label', pieceName(piece) + ' on ' + squareName);
      }

      if (rankIndex === ranks.length - 1) {
        square.append(createCoordinate('file', file));
      }
      if (fileIndex === 0) {
        square.append(createCoordinate('rank', rank));
      }
      fragment.append(square);
    });
  });

  els.board.replaceChildren(fragment);
  renderBoardArrows();
  updatePositionFacts(chess);
}

function createCoordinate(type, value) {
  const coordinate = document.createElement('span');
  coordinate.className = 'coord ' + type;
  coordinate.textContent = value;
  coordinate.setAttribute('aria-hidden', 'true');
  return coordinate;
}

function pieceName(piece) {
  const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  return (piece.color === 'w' ? 'White ' : 'Black ') + names[piece.type];
}

function findKing(chess, color) {
  for (const file of FILES) {
    for (const rank of RANKS) {
      const piece = chess.get(file + rank);
      if (piece?.type === 'k' && piece.color === color) return file + rank;
    }
  }
  return null;
}

function renderGameHeading() {
  const white = state.headers.White || 'White';
  const black = state.headers.Black || 'Black';
  const event = state.headers.Event || 'King of the Hill';
  els['game-event'].textContent = (state.headers.Variant || 'King of the Hill').toUpperCase();
  els['game-title'].textContent = event;
  els['player-line'].innerHTML = `${escapeHtml(white)} <span>vs</span> ${escapeHtml(black)}`;
}

function renderMoveList() {
  const fragment = document.createDocumentFragment();
  const moves = state.positions.slice(1);
  els['empty-moves'].hidden = moves.length > 0;

  for (let pairIndex = 0; pairIndex < Math.ceil(moves.length / 2); pairIndex += 1) {
    const number = document.createElement('span');
    number.className = 'move-number';
    number.textContent = String(pairIndex + 1) + '.';
    fragment.append(number);

    for (let colorIndex = 0; colorIndex < 2; colorIndex += 1) {
      const moveIndex = pairIndex * 2 + colorIndex;
      if (!moves[moveIndex]) {
        fragment.append(document.createElement('span'));
        continue;
      }
      const positionIndex = moveIndex + 1;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'move-button' + (state.currentIndex === positionIndex ? ' active' : '');
      button.dataset.position = String(positionIndex);
      button.textContent = moves[moveIndex].move.san;
      const analysis = state.analyses[positionIndex];
      if (analysis) {
        const evaluation = document.createElement('span');
        evaluation.className = 'move-eval';
        evaluation.textContent = formatScore(analysis);
        button.append(evaluation);
      }
      fragment.append(button);
    }
  }

  els['move-list'].replaceChildren(fragment);
}

function renderAnalysis() {
  setAnalysisControls(state.analyzing);
  const winner = hillWinner(new Chess(state.positions[state.currentIndex].fen));
  if (winner) {
    const whiteWon = winner.color === 'w';
    setScoreDisplay(whiteWon ? 8 : -8, null, true);
    els.score.textContent = whiteWon ? '1–0' : '0–1';
    els['score-owner'].textContent = `${whiteWon ? 'White' : 'Black'} reached ${winner.square}`;
    els['eval-label'].textContent = 'WIN';
    renderBestMessage(`${whiteWon ? 'White' : 'Black'} wins on ${winner.square}`);
    renderBoardArrows();
    return;
  }
  const analysis = state.analyses[state.currentIndex];
  if (!analysis) {
    setScoreDisplay(0, null, false);
    renderBestLines([]);
    renderBoardArrows();
    return;
  }
  setScoreDisplay(analysis.score, analysis.mate, true);
  const lines = analysis.lines?.length ? analysis.lines : [analysis];
  renderBestLines(lines.slice(0, state.lineCount));
  renderBoardArrows();
}

function setScoreDisplay(score, mate, hasAnalysis) {
  const bounded = Math.max(-8, Math.min(8, score || 0));
  const whitePercent = 50 + 46 * Math.tanh(bounded / 4);
  els['eval-white'].style.height = whitePercent + '%';
  els['eval-black'].style.height = 100 - whitePercent + '%';
  els.score.textContent = mate !== null && mate !== undefined
    ? (mate > 0 ? 'M' + Math.abs(mate) : '-M' + Math.abs(mate))
    : (score >= 0 ? '+' : '') + Number(score || 0).toFixed(1);
  els['eval-label'].textContent = hasAnalysis ? els.score.textContent : '0.0';
  els['score-owner'].textContent = !hasAnalysis || Math.abs(score) < 0.15
    ? 'Equal'
    : score > 0 ? 'White is better' : 'Black is better';
}

function formatScore(analysis) {
  if (analysis.mate !== null && analysis.mate !== undefined) {
    return analysis.mate > 0 ? 'M' + Math.abs(analysis.mate) : '-M' + Math.abs(analysis.mate);
  }
  return (analysis.score >= 0 ? '+' : '') + analysis.score.toFixed(1);
}

function renderBestLines(lines) {
  if (!lines.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'Analyze the position to see the engine line.';
    els['best-line'].replaceChildren(empty);
    return;
  }

  const fen = state.positions[state.currentIndex].fen;
  els['best-line'].replaceChildren(...lines.map((line, lineIndex) => {
    const row = document.createElement('li');
    row.className = 'pv-line-row';
    const meta = document.createElement('span');
    meta.className = 'pv-line-meta';
    meta.textContent = `${lineIndex + 1}  ${formatScore(line)}`;
    const moves = document.createElement('div');
    moves.className = 'pv-line-moves';
    const steps = buildPvSteps(fen, line.pv || []);
    steps.forEach((step, plyIndex) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pv-move' + (
        state.preview?.line === lineIndex && state.preview?.ply === plyIndex + 1 ? ' active' : ''
      );
      button.dataset.pvLine = String(lineIndex);
      button.dataset.pvPly = String(plyIndex + 1);
      button.textContent = step.san;
      button.title = `Preview line ${lineIndex + 1} after ${step.san}`;
      moves.append(button);
    });
    row.append(meta, moves);
    return row;
  }));
}

function renderBestMessage(message) {
  const item = document.createElement('li');
  item.className = 'muted';
  item.textContent = message;
  els['best-line'].replaceChildren(item);
}

function renderBoardArrows() {
  els.board.querySelector('.analysis-arrows')?.remove();
  if (state.preview || !state.showArrows || hillWinner(new Chess(state.positions[state.currentIndex].fen))) return;

  const analysis = state.analyses[state.currentIndex];
  if (!analysis) return;
  const lines = analysis.lines?.length ? analysis.lines : [analysis];
  const firstMoves = lines
    .slice(0, state.lineCount)
    .map((line) => line.pv?.[0])
    .filter((move, index, moves) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) && moves.indexOf(move) === index);
  if (!firstMoves.length) return;

  const svgNamespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.classList.add('analysis-arrows');
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('aria-hidden', 'true');
  const colors = ['#d4ed67', '#55b7d6', '#e59863'];

  firstMoves.forEach((move, index) => {
    const from = arrowSquareCenter(move.slice(0, 2));
    const to = arrowSquareCenter(move.slice(2, 4));
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (!length) return;
    const ux = dx / length;
    const uy = dy / length;
    const px = -uy;
    const py = ux;
    const color = colors[index];
    const start = { x: from.x + ux * 0.17, y: from.y + uy * 0.17 };
    const base = { x: to.x - ux * 0.38, y: to.y - uy * 0.38 };
    const tip = { x: to.x - ux * 0.07, y: to.y - uy * 0.07 };

    const shaft = document.createElementNS(svgNamespace, 'line');
    shaft.setAttribute('x1', start.x);
    shaft.setAttribute('y1', start.y);
    shaft.setAttribute('x2', base.x + ux * 0.08);
    shaft.setAttribute('y2', base.y + uy * 0.08);
    shaft.setAttribute('stroke', color);
    shaft.setAttribute('stroke-width', '0.14');
    shaft.setAttribute('stroke-linecap', 'round');
    shaft.setAttribute('opacity', '0.88');

    const head = document.createElementNS(svgNamespace, 'polygon');
    head.setAttribute('points', [
      `${tip.x},${tip.y}`,
      `${base.x + px * 0.2},${base.y + py * 0.2}`,
      `${base.x - px * 0.2},${base.y - py * 0.2}`,
    ].join(' '));
    head.setAttribute('fill', color);
    head.setAttribute('opacity', '0.88');
    svg.append(shaft, head);
  });

  els.board.append(svg);
}

function arrowSquareCenter(square) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return state.orientation === 'w'
    ? { x: file + 0.5, y: 8 - rank + 0.5 }
    : { x: 7 - file + 0.5, y: rank - 0.5 };
}

function buildPvSteps(fen, uciMoves) {
  const chess = new Chess(fen);
  const steps = [];
  for (const uci of uciMoves.slice(0, 12)) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) break;
    try {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined,
      });
      if (!move) break;
      steps.push({
        san: move.san,
        fen: chess.fen(),
        move: { from: move.from, to: move.to, san: move.san },
      });
      if (kingReachedHill(chess)) break;
    } catch {
      break;
    }
  }
  return steps;
}

function updatePositionFacts(chess) {
  const move = state.positions[state.currentIndex].move;
  const winner = hillWinner(chess);
  if (winner) {
    els['turn-value'].textContent = winner.color === 'w' ? 'White won' : 'Black won';
    els['hill-distance'].textContent = `King on ${winner.square}`;
  } else {
    els['turn-value'].textContent = chess.turn() === 'w' ? 'White' : 'Black';
    const kingSquare = findKing(chess, chess.turn());
    const distance = kingSquare ? distanceToHill(kingSquare) : null;
    els['hill-distance'].textContent = distance === null
      ? 'Unknown'
      : distance + (distance === 1 ? ' square' : ' squares');
  }
  if (state.preview) {
    els['position-number'].textContent = `PV ${state.preview.ply}`;
    els['position-label'].textContent = `Engine line · ${state.preview.san}`;
    els['return-preview'].hidden = false;
  } else {
    els['position-number'].textContent = state.currentIndex === 0
      ? 'Start'
      : `${Math.ceil(state.currentIndex / 2)}${state.currentIndex % 2 ? '. White' : '... Black'}`;
    els['position-label'].textContent = state.currentIndex === 0
      ? 'Starting position'
      : `${state.currentIndex} / ${state.positions.length - 1} · ${move?.san || ''}`;
    els['return-preview'].hidden = true;
  }
}

function distanceToHill(square) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return Math.min(...[...HILL_SQUARES].map((hill) => (
    Math.abs(file - FILES.indexOf(hill[0])) + Math.abs(rank - Number(hill[1]))
  )));
}

function kingReachedHill(chess) {
  return Boolean(hillWinner(chess));
}

function hillWinner(chess) {
  const whiteSquare = findKing(chess, 'w');
  if (HILL_SQUARES.has(whiteSquare)) return { color: 'w', square: whiteSquare };
  const blackSquare = findKing(chess, 'b');
  if (HILL_SQUARES.has(blackSquare)) return { color: 'b', square: blackSquare };
  return null;
}

function updateNavigation() {
  els['first-move'].disabled = state.currentIndex === 0;
  els['previous-move'].disabled = state.currentIndex === 0;
  els['next-move'].disabled = state.currentIndex >= state.positions.length - 1;
  els['last-move'].disabled = state.currentIndex >= state.positions.length - 1;
}

function goToPosition(index) {
  clearBoardSelection();
  state.preview = null;
  state.currentIndex = Math.max(0, Math.min(state.positions.length - 1, index));
  renderBoard();
  renderMoveList();
  renderAnalysis();
  updateNavigation();
}

function previewBestLine(lineIndex, ply) {
  const analysis = state.analyses[state.currentIndex];
  if (!analysis?.pv?.length) return;
  const lines = analysis.lines?.length ? analysis.lines : [analysis];
  const line = lines[lineIndex];
  if (!line) return;
  const step = buildPvSteps(state.positions[state.currentIndex].fen, line.pv)[ply - 1];
  if (!step) return;
  clearBoardSelection();
  state.preview = {
    fen: step.fen,
    move: step.move,
    line: lineIndex,
    ply,
    san: step.san,
  };
  renderBoard();
  renderAnalysis();
  setAnalysisControls(false);
}

function returnToGamePosition() {
  if (!state.preview) return;
  state.preview = null;
  renderBoard();
  renderAnalysis();
  setAnalysisControls(false);
}

async function analyzeCurrentPosition() {
  if (state.analyzing) return;
  if (hillWinner(new Chess(state.positions[state.currentIndex].fen))) {
    showToast('This game has already ended on the hill');
    return;
  }
  const index = state.currentIndex;
  const requestedDepth = Number(els.depth.value);
  if (analysisMeetsRequest(state.analyses[index], requestedDepth, state.lineCount)) {
    renderAnalysis();
    showToast(`Reused depth ${state.analyses[index].depth} analysis`);
    return;
  }
  state.analyzing = true;
  setAnalysisControls(true);
  setEngineStatus('working', 'Analyzing position');
  try {
    const result = await engine.analyze(
      state.positions[index].fen,
      requestedDepth,
      state.lineCount,
      (partial) => updateLiveAnalysis(index, partial),
    );
    state.analyses[index] = result;
    renderAnalysis();
    renderMoveList();
    markUnsaved();
    setEngineStatus('ready', engine.readyText);
    els['engine-note'].textContent = ENGINE_NOTE;
  } catch (error) {
    handleEngineError(error);
  } finally {
    state.analyzing = false;
    setAnalysisControls(false);
  }
}

async function analyzeFullGame() {
  if (state.analyzing) return;
  state.analyzing = true;
  state.cancelRequested = false;
  setAnalysisControls(true);
  els['progress-wrap'].hidden = false;
  setEngineStatus('working', 'Analyzing full game');
  const total = state.positions.length;

  try {
    for (let index = 0; index < total; index += 1) {
      if (state.cancelRequested) break;
      updateProgress(index, total);
      if (analysisMeetsRequest(state.analyses[index], Number(els.depth.value), state.lineCount)) continue;
      const winner = hillWinner(new Chess(state.positions[index].fen));
      if (winner) {
        state.analyses[index] = {
          depth: 0,
          score: winner.color === 'w' ? 100 : -100,
          mate: null,
          pv: [],
          lines: [],
          multiPv: state.lineCount,
          bestMove: '(none)',
        };
        continue;
      }
      const result = await engine.analyze(
        state.positions[index].fen,
        Number(els.depth.value),
        state.lineCount,
      );
      state.analyses[index] = result;
      if (state.currentIndex === index) renderAnalysis();
      renderMoveList();
    }
    updateProgress(total, total);
    renderMoveList();
    renderAnalysis();
    markUnsaved();
    showToast(state.cancelRequested ? 'Analysis stopped' : 'Full game analyzed');
    setEngineStatus('ready', engine.readyText);
    els['engine-note'].textContent = ENGINE_NOTE;
  } catch (error) {
    handleEngineError(error);
  } finally {
    state.analyzing = false;
    state.cancelRequested = false;
    setAnalysisControls(false);
    window.setTimeout(() => { els['progress-wrap'].hidden = true; }, 700);
  }
}

function analysisMeetsRequest(analysis, depth, lineCount) {
  if (!analysis || analysis.depth < depth) return false;
  return (analysis.multiPv || 1) >= lineCount;
}

let liveAnalysisFrame = null;
function updateLiveAnalysis(index, partial) {
  state.analyses[index] = partial;
  if (partial.depth) setEngineStatus('working', `Analyzing · depth ${partial.depth}`);
  if (state.currentIndex !== index || liveAnalysisFrame !== null) return;
  liveAnalysisFrame = requestAnimationFrame(() => {
    liveAnalysisFrame = null;
    renderAnalysis();
    renderMoveList();
  });
}

function stopAnalysis() {
  if (!state.analyzing) return;
  state.cancelRequested = true;
  engine.stop();
}

function setAnalysisControls(disabled) {
  const terminal = hillWinner(new Chess(state.positions[state.currentIndex].fen));
  els['analyze-position'].disabled = disabled || Boolean(terminal) || Boolean(state.preview);
  els['analyze-game'].disabled = disabled || Boolean(state.preview);
  els.depth.disabled = disabled;
  els['show-arrows'].disabled = disabled;
  els['line-selector'].querySelectorAll('button').forEach((button) => {
    button.disabled = disabled;
  });
}

function updateProgress(completed, total) {
  els['progress-bar'].style.width = Math.round((completed / Math.max(total, 1)) * 100) + '%';
  els['progress-text'].textContent = `Analyzing ${completed} / ${total}`;
}

function handleEngineError(error) {
  console.error(error);
  if (error.code === 'ANALYSIS_TIMEOUT') {
    engine.stop();
    setEngineStatus('ready', engine.readyText);
    els['engine-note'].textContent = 'The search was stopped after 10 minutes. Reduce depth or the number of lines for a faster result.';
    showToast(error.message);
    return;
  }
  setEngineStatus('error', 'Engine unavailable');
  els['engine-note'].textContent = error.message;
  showToast(error.message);
}

function setEngineStatus(status, text) {
  els['engine-status'].dataset.state = status;
  els['engine-status-text'].textContent = text;
}

function readSavedGames() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function writeSavedGames() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.savedGames));
}

function saveCurrentGame() {
  if (!state.pgn) {
    showToast('Import a PGN before saving');
    openImportDialog();
    return;
  }

  const id = state.savedId || crypto.randomUUID();
  const saved = {
    id,
    pgn: state.pgn,
    headers: state.headers,
    positions: state.positions,
    analyses: state.analyses,
    savedAt: new Date().toISOString(),
  };
  const existing = state.savedGames.findIndex((game) => game.id === id);
  if (existing >= 0) state.savedGames.splice(existing, 1, saved);
  else state.savedGames.unshift(saved);
  state.savedId = id;
  writeSavedGames();
  renderLibrary();
  els['save-state'].textContent = 'Saved locally';
  showToast('Game saved in this browser');
}

function renderLibrary() {
  els['saved-count'].textContent = String(state.savedGames.length);
  els['empty-library'].hidden = state.savedGames.length > 0;
  const fragment = document.createDocumentFragment();

  for (const game of state.savedGames) {
    const entry = document.createElement('div');
    entry.className = 'library-entry';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'library-game' + (state.savedId === game.id ? ' active' : '');
    button.dataset.gameId = game.id;
    const title = document.createElement('strong');
    title.textContent = game.headers?.Event || 'Untitled game';
    const players = document.createElement('span');
    players.textContent = `${game.headers?.White || 'White'} vs ${game.headers?.Black || 'Black'}`;
    const time = document.createElement('time');
    time.dateTime = game.savedAt;
    time.textContent = formatDate(game.savedAt);
    button.append(title, players, time);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'library-remove';
    remove.dataset.removeId = game.id;
    remove.title = 'Delete saved game';
    remove.setAttribute('aria-label', 'Delete ' + title.textContent);
    remove.textContent = '×';
    entry.append(button, remove);
    fragment.append(entry);
  }
  els['saved-games'].replaceChildren(fragment);
}

function deleteSavedGame(id) {
  state.savedGames = state.savedGames.filter((game) => game.id !== id);
  if (state.savedId === id) {
    state.savedId = null;
    els['save-state'].textContent = 'Not saved';
  }
  writeSavedGames();
  renderLibrary();
  showToast('Saved game removed');
}

function openLibrary() {
  els['saved-games'].closest('.library-panel').classList.add('open');
  els['library-backdrop'].classList.add('visible');
}

function closeLibrary() {
  els['saved-games'].closest('.library-panel').classList.remove('open');
  els['library-backdrop'].classList.remove('visible');
}

function markUnsaved() {
  if (state.savedId) els['save-state'].textContent = 'Changes not saved';
}

function openImportDialog() {
  els['pgn-error'].textContent = '';
  els['pgn-input'].value = state.pgn;
  els['import-dialog'].showModal();
  window.setTimeout(() => els['pgn-input'].focus(), 0);
}

function closeImportDialog() {
  els['import-dialog'].close();
}

function importPgn() {
  const pgn = els['pgn-input'].value.trim();
  if (!pgn) {
    els['pgn-error'].textContent = 'Paste a PGN to continue.';
    return;
  }
  try {
    loadGame(parsePgn(pgn));
    closeImportDialog();
    showToast('PGN loaded');
  } catch (error) {
    els['pgn-error'].textContent = 'Could not read this PGN: ' + error.message;
  }
}

function switchTab(tab) {
  const showAnalysis = tab === 'analysis';
  els['analysis-tab'].classList.toggle('active', showAnalysis);
  els['moves-tab'].classList.toggle('active', !showAnalysis);
  els['analysis-tab'].setAttribute('aria-selected', String(showAnalysis));
  els['moves-tab'].setAttribute('aria-selected', String(!showAnalysis));
  els['analysis-view'].hidden = !showAnalysis;
  els['moves-view'].hidden = showAnalysis;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 2600);
}

let wheelDelta = 0;
let wheelResetTimer;
function navigateWithWheel(event) {
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

  const direction = Math.sign(event.deltaY);
  const canMove = direction > 0
    ? state.currentIndex < state.positions.length - 1
    : state.currentIndex > 0;
  if (!canMove) {
    wheelDelta = 0;
    return;
  }

  event.preventDefault();
  wheelDelta += event.deltaY;
  clearTimeout(wheelResetTimer);
  wheelResetTimer = setTimeout(() => { wheelDelta = 0; }, 160);
  if (Math.abs(wheelDelta) < 36) return;

  goToPosition(state.currentIndex + Math.sign(wheelDelta));
  wheelDelta = 0;
}

function handleBoardClick(event) {
  const square = event.target.closest('.square')?.dataset.square;
  if (!square || state.analyzing || state.preview) return;
  const chess = new Chess(state.positions[state.currentIndex].fen);
  if (hillWinner(chess)) return;

  if (state.selectedSquare) {
    if (attemptBoardMove(state.selectedSquare, square)) return;
    if (state.selectedSquare === square) {
      clearBoardSelection();
      renderBoard();
      return;
    }
  }

  const piece = chess.get(square);
  if (piece?.color === chess.turn()) {
    state.selectedSquare = square;
    state.legalMoves = chess.moves({ square, verbose: true });
  } else {
    clearBoardSelection();
  }
  renderBoard();
}

function attemptBoardMove(from, to) {
  if (state.analyzing || state.preview) return false;
  const chess = new Chess(state.positions[state.currentIndex].fen);
  const candidates = chess.moves({ square: from, verbose: true }).filter((move) => move.to === to);
  if (!candidates.length) return false;
  const candidate = candidates.find((move) => move.promotion === 'q') || candidates[0];
  const applied = chess.move({ from, to, promotion: candidate.promotion });
  if (!applied) return false;

  const branchIndex = state.currentIndex;
  state.positions = state.positions.slice(0, branchIndex + 1);
  state.positions.push({
    fen: chess.fen(),
    move: {
      from: applied.from,
      to: applied.to,
      san: applied.san,
      color: applied.color,
      variation: true,
    },
  });
  Object.keys(state.analyses).forEach((index) => {
    if (Number(index) > branchIndex) delete state.analyses[index];
  });
  state.currentIndex = branchIndex + 1;
  state.headers = { ...state.headers, Result: '*' };
  delete state.headers.Termination;
  clearBoardSelection();
  renderBoard();
  renderMoveList();
  renderAnalysis();
  updateNavigation();
  markUnsaved();

  if (!hillWinner(chess) && !chess.isGameOver()) {
    window.setTimeout(analyzeCurrentPosition, 80);
  }
  return true;
}

function clearBoardSelection() {
  state.selectedSquare = null;
  state.legalMoves = [];
}

function handleBoardDragStart(event) {
  const piece = event.target.closest('.piece');
  const square = piece?.closest('.square.playable');
  if (!piece || !square || state.analyzing) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', square.dataset.square);
  event.dataTransfer.setDragImage(piece, piece.clientWidth / 2, piece.clientHeight / 2);
}

function handleBoardDrop(event) {
  const target = event.target.closest('.square')?.dataset.square;
  const source = event.dataTransfer.getData('text/plain');
  if (!source || !target) return;
  event.preventDefault();
  attemptBoardMove(source, target);
}

function renderArrowControls() {
  els['show-arrows'].checked = state.showArrows;
  els['line-selector'].querySelectorAll('[data-line-count]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.lineCount) === state.lineCount);
  });
}

els['import-open'].addEventListener('click', openImportDialog);
els['saved-open'].addEventListener('click', openLibrary);
els['saved-close'].addEventListener('click', closeLibrary);
els['library-backdrop'].addEventListener('click', closeLibrary);
els['new-game'].addEventListener('click', () => {
  closeLibrary();
  resetWorkspace();
});
els['import-close'].addEventListener('click', closeImportDialog);
els['cancel-import'].addEventListener('click', closeImportDialog);
els['load-example'].addEventListener('click', () => {
  els['pgn-input'].value = EXAMPLE_PGN;
  els['pgn-error'].textContent = '';
});
els['import-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  importPgn();
});
els['flip-board'].addEventListener('click', () => {
  state.orientation = state.orientation === 'w' ? 'b' : 'w';
  renderBoard();
});
els.board.addEventListener('click', handleBoardClick);
els.board.addEventListener('dragstart', handleBoardDragStart);
els.board.addEventListener('dragover', (event) => event.preventDefault());
els.board.addEventListener('drop', handleBoardDrop);
els.board.addEventListener('wheel', navigateWithWheel, { passive: false });
els['first-move'].addEventListener('click', () => goToPosition(0));
els['previous-move'].addEventListener('click', () => goToPosition(state.currentIndex - 1));
els['next-move'].addEventListener('click', () => goToPosition(state.currentIndex + 1));
els['last-move'].addEventListener('click', () => goToPosition(state.positions.length - 1));
els['move-list'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-position]');
  if (button) goToPosition(Number(button.dataset.position));
});
els['best-line'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-pv-ply]');
  if (button) previewBestLine(Number(button.dataset.pvLine), Number(button.dataset.pvPly));
});
els['return-preview'].addEventListener('click', returnToGamePosition);
els['saved-games'].addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-id]');
  if (remove) {
    deleteSavedGame(remove.dataset.removeId);
    return;
  }
  const button = event.target.closest('[data-game-id]');
  if (!button) return;
  const game = state.savedGames.find((candidate) => candidate.id === button.dataset.gameId);
  if (game) {
    loadGame(game);
    closeLibrary();
  }
});
els['analysis-tab'].addEventListener('click', () => switchTab('analysis'));
els['moves-tab'].addEventListener('click', () => switchTab('moves'));
els['analyze-position'].addEventListener('click', analyzeCurrentPosition);
els['analyze-game'].addEventListener('click', analyzeFullGame);
els['cancel-analysis'].addEventListener('click', stopAnalysis);
els['save-game'].addEventListener('click', saveCurrentGame);
els.depth.addEventListener('input', () => {
  els['depth-value'].textContent = els.depth.value;
});
els['show-arrows'].addEventListener('change', () => {
  state.showArrows = els['show-arrows'].checked;
  localStorage.setItem('hill-lab-show-arrows', String(state.showArrows));
  renderBoardArrows();
});
els['line-selector'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-line-count]');
  if (!button || state.analyzing) return;
  state.lineCount = Number(button.dataset.lineCount);
  localStorage.setItem('hill-lab-line-count', String(state.lineCount));
  renderArrowControls();
  renderBoardArrows();
  const analysis = state.analyses[state.currentIndex];
  if (analysis && (analysis.multiPv || 1) < state.lineCount) {
    showToast(`Analyze again to calculate ${state.lineCount} lines`);
  }
});
document.addEventListener('keydown', (event) => {
  if (els['import-dialog'].open || event.target.matches('input, textarea')) return;
  if (event.key === 'ArrowLeft') goToPosition(state.currentIndex - 1);
  if (event.key === 'ArrowRight') goToPosition(state.currentIndex + 1);
});

renderArrowControls();
renderAll();
engine.init()
  .then(() => { state.engineReady = true; })
  .catch((error) => {
    console.error(error);
    els['engine-note'].textContent = error.message;
  });
