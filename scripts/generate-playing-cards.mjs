import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUTPUT_DIR = resolve('apps/mobile/assets/cards');
const CARD_WIDTH = 504;
const CARD_HEIGHT = 704;
const CANVAS_SIZE = 704;
const CARD_X = 100;

const suits = {
  clubs: { symbol: '♣', color: '#211F26', accent: '#3B6F61' },
  diamonds: { symbol: '♦', color: '#C8324B', accent: '#C8324B' },
  hearts: { symbol: '♥', color: '#C8324B', accent: '#C8324B' },
  spades: { symbol: '♠', color: '#211F26', accent: '#375A7A' },
};

const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const pipLayouts = {
  2: [
    [252, 166],
    [252, 538],
  ],
  3: [
    [252, 154],
    [252, 352],
    [252, 550],
  ],
  4: [
    [166, 170],
    [338, 170],
    [166, 534],
    [338, 534],
  ],
  5: [
    [166, 160],
    [338, 160],
    [252, 352],
    [166, 544],
    [338, 544],
  ],
  6: [
    [166, 150],
    [338, 150],
    [166, 352],
    [338, 352],
    [166, 554],
    [338, 554],
  ],
  7: [
    [166, 140],
    [338, 140],
    [252, 252],
    [166, 352],
    [338, 352],
    [166, 564],
    [338, 564],
  ],
  8: [
    [166, 130],
    [338, 130],
    [252, 236],
    [166, 310],
    [338, 310],
    [252, 468],
    [166, 574],
    [338, 574],
  ],
  9: [
    [166, 128],
    [338, 128],
    [166, 278],
    [338, 278],
    [252, 352],
    [166, 426],
    [338, 426],
    [166, 576],
    [338, 576],
  ],
  10: [
    [166, 120],
    [338, 120],
    [252, 218],
    [166, 286],
    [338, 286],
    [166, 418],
    [338, 418],
    [252, 486],
    [166, 584],
    [338, 584],
  ],
};

function text({ x, y, size, fill, content, anchor = 'middle', weight = 700, rotate = 0 }) {
  const transform = rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : '';
  return `<text x="${x + CARD_X}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${size}" font-weight="${weight}" fill="${fill}"${transform}>${content}</text>`;
}

function suitShape(suitName, color, x, y, size, rotate = 0, cardOffset = true) {
  const shape = {
    hearts:
      '<path d="M0 44 C-9 29-46 8-46-20 C-46-44-15-53 0-28 C15-53 46-44 46-20 C46 8 9 29 0 44Z"/>',
    diamonds: '<path d="M0-50 L38 0 L0 50 L-38 0Z"/>',
    clubs:
      '<circle cx="0" cy="-27" r="25"/><circle cx="-25" cy="1" r="25"/><circle cx="25" cy="1" r="25"/><path d="M-8 10 C-8 33-17 39-25 47 H25 C17 39 8 33 8 10Z"/>',
    spades:
      '<path d="M0-50 C-9-34-46-12-46 16 C-46 40-15 47 0 23 C15 47 46 40 46 16 C46-12 9-34 0-50Z"/><path d="M-8 13 C-8 34-17 41-26 49 H26 C17 41 8 34 8 13Z"/>',
  }[suitName];
  const absoluteX = x + (cardOffset ? CARD_X : 0);
  return `<g fill="${color}" transform="translate(${absoluteX} ${y}) rotate(${rotate}) scale(${size / 100})">${shape}</g>`;
}

function corner(rank, suitName, color, bottom = false) {
  const group = `
    ${text({ x: 51, y: 51, size: rank === '10' ? 61 : 72, fill: color, content: rank })}
    ${suitShape(suitName, color, 51, 108, 53)}`;
  if (!bottom) return group;
  return `<g transform="rotate(180 ${CARD_X + CARD_WIDTH / 2} ${CARD_HEIGHT / 2})">${group}</g>`;
}

function pip(suitName, color, x, y, size = 68) {
  const rotate = y > CARD_HEIGHT / 2 ? 180 : 0;
  return suitShape(suitName, color, x, y, size, rotate);
}

function courtFigure(kind, suitName, suitColor, accent) {
  const crown =
    kind === 13
      ? `<path d="M197 163 L214 105 L252 145 L290 105 L307 163 Z" fill="#E9B949" stroke="#211F26" stroke-width="6" stroke-linejoin="round"/>
       <circle cx="214" cy="105" r="8" fill="${suitColor}"/><circle cx="252" cy="145" r="8" fill="${accent}"/><circle cx="290" cy="105" r="8" fill="${suitColor}"/>`
      : kind === 12
        ? `<path d="M200 158 L218 116 L252 149 L286 116 L304 158" fill="#E9B949" stroke="#211F26" stroke-width="6" stroke-linejoin="round"/>
         <circle cx="218" cy="116" r="7" fill="${accent}"/><circle cx="286" cy="116" r="7" fill="${accent}"/>`
        : `<path d="M208 153 L225 119 L252 148 L279 119 L296 153" fill="#E9B949" stroke="#211F26" stroke-width="6" stroke-linejoin="round"/>`;

  const hair =
    kind === 12
      ? `<path d="M197 190 Q188 226 210 270 L228 252 L252 275 L276 252 L294 270 Q316 226 307 190 Q289 158 252 158 Q215 158 197 190Z" fill="#9A583D" stroke="#211F26" stroke-width="5"/>`
      : `<path d="M202 187 Q190 220 211 260 L229 244 L252 267 L275 244 L293 260 Q314 220 302 187 Q284 161 252 161 Q220 161 202 187Z" fill="#3B302E" stroke="#211F26" stroke-width="5"/>`;

  const feature =
    kind === 13
      ? `<path d="M220 233 Q252 279 284 233 Q281 300 252 310 Q223 300 220 233Z" fill="#F4F0E6" stroke="#211F26" stroke-width="4"/>
       <path d="M231 271 Q252 286 273 271" fill="none" stroke="#211F26" stroke-width="4"/>`
      : kind === 12
        ? `<path d="M232 253 Q252 266 272 253" fill="none" stroke="#9B3045" stroke-width="4"/>`
        : `<path d="M229 255 Q252 268 275 255" fill="none" stroke="#211F26" stroke-width="4"/>
         <path d="M208 287 L181 333" stroke="#E9B949" stroke-width="12" stroke-linecap="round"/>`;

  const collar =
    kind === 12
      ? `<path d="M205 291 L252 330 L299 291 L319 340 L185 340 Z" fill="${accent}" stroke="#211F26" stroke-width="5"/>
       <path d="M219 294 L252 320 L285 294" fill="#FFF7E8" stroke="#211F26" stroke-width="4"/>`
      : `<path d="M203 289 L252 328 L301 289 L323 340 L181 340 Z" fill="${accent}" stroke="#211F26" stroke-width="5"/>
       <path d="M218 292 L252 319 L286 292" fill="#FFF7E8" stroke="#211F26" stroke-width="4"/>`;

  const upper = `
    <g transform="translate(${CARD_X} 0)">
      ${crown}
      ${hair}
      <ellipse cx="252" cy="220" rx="47" ry="59" fill="#F1C7A5" stroke="#211F26" stroke-width="5"/>
      <path d="M218 218 Q230 209 240 218 M264 218 Q274 209 286 218" fill="none" stroke="#211F26" stroke-width="5" stroke-linecap="round"/>
      <path d="M252 225 L246 244 L258 244" fill="none" stroke="#A66C55" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      ${feature}
      ${collar}
      ${suitShape(suitName, suitColor, kind === 11 ? 307 : 196, 304, 43, 0, false)}
    </g>`;

  return `
    <rect x="${CARD_X + 104}" y="80" width="296" height="544" rx="13" fill="#FFF8E9" stroke="#211F26" stroke-width="5"/>
    <path d="M${CARD_X + 252} 80 V624" stroke="${suitColor}" stroke-width="4" opacity="0.3"/>
    <clipPath id="court-clip"><rect x="${CARD_X + 108}" y="84" width="288" height="536" rx="9"/></clipPath>
    <g clip-path="url(#court-clip)">
      ${upper}
      <g transform="rotate(180 ${CARD_X + CARD_WIDTH / 2} ${CARD_HEIGHT / 2})">${upper}</g>
    </g>`;
}

function cardSvg(suitName, rankNumber) {
  const { color, accent } = suits[suitName];
  const rank = ranks[rankNumber - 1];
  let face = '';

  if (rankNumber === 1) {
    face = `${pip(suitName, color, 252, 352, 170)}
      <path d="M${CARD_X + 206} 438 Q${CARD_X + 252} 456 ${CARD_X + 298} 438" fill="none" stroke="${accent}" stroke-width="5" opacity="0.4"/>`;
  } else if (rankNumber <= 10) {
    face = pipLayouts[rankNumber].map(([x, y]) => pip(suitName, color, x, y)).join('\n');
  } else {
    face = courtFigure(rankNumber, suitName, color, accent);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" viewBox="0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}">
    <rect x="${CARD_X + 3}" y="3" width="${CARD_WIDTH - 6}" height="${CARD_HEIGHT - 6}" rx="28" fill="#FFFDF8" stroke="#26212A" stroke-width="6"/>
    ${corner(rank, suitName, color)}
    ${corner(rank, suitName, color, true)}
    ${face}
  </svg>`;
}

function run() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const tempRoot = mkdtempSync(join(tmpdir(), 'ldr-playing-cards-'));
  const svgDir = join(tempRoot, 'svg');
  const previewDir = join(tempRoot, 'preview');
  mkdirSync(svgDir);
  mkdirSync(previewDir);

  try {
    const svgPaths = [];
    for (const suitName of Object.keys(suits)) {
      for (let rank = 1; rank <= 13; rank += 1) {
        const filename = `${suitName}-${rank}.svg`;
        const path = join(svgDir, filename);
        writeFileSync(path, cardSvg(suitName, rank));
        svgPaths.push(path);
      }
    }

    execFileSync('qlmanage', ['-t', '-s', String(CANVAS_SIZE), '-o', previewDir, ...svgPaths], {
      stdio: 'ignore',
    });

    for (const svgPath of svgPaths) {
      const basename = svgPath.split('/').at(-1);
      const source = join(previewDir, `${basename}.png`);
      const cropped = join(tempRoot, `${basename}.cropped.png`);
      const output = join(OUTPUT_DIR, basename.replace('.svg', '.png'));
      execFileSync(
        'sips',
        ['--cropToHeightWidth', String(CARD_HEIGHT), String(CARD_WIDTH), source, '--out', cropped],
        { stdio: 'ignore' },
      );
      execFileSync('sips', ['-z', '352', '252', cropped, '--out', output], { stdio: 'ignore' });
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

run();
