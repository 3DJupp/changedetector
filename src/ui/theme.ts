/** Design tokens and the single stylesheet, taken from the product design. */

export const COLORS = {
  bg: '#0E1116',
  panel: '#151A21',
  panelAlt: '#1B2129',
  ink: '#E6EAF0',
  muted: '#8892A0',
  dim: '#93A0B0',
  accent: '#2A78D6',
  link: '#5FA0E8',
  red: '#F2545B',
  amber: '#E9A13B',
  green: '#3FBF7F',
  paper: '#F4F2ED',
  paperInk: '#16181C',
};

export const SEVERITY_COLORS: Record<string, { color: string; background: string }> = {
  MAJOR: { color: '#F2545B', background: 'rgba(242,84,91,.13)' },
  SIGNIFICANT: { color: '#E9A13B', background: 'rgba(233,161,59,.13)' },
  MODERATE: { color: '#E9A13B', background: 'rgba(233,161,59,.13)' },
  MINOR: { color: '#5FA0E8', background: 'rgba(42,120,214,.15)' },
  TRIVIAL: { color: '#93A0B0', background: 'rgba(255,255,255,.07)' },
};

export const CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:${COLORS.bg};font-family:"Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:${COLORS.ink};-webkit-font-smoothing:antialiased;font-size:15px}
a{color:${COLORS.link};text-decoration:none}
a:hover{color:#8CBEF2;text-decoration:underline}
::selection{background:${COLORS.accent};color:#fff}
input,select,button,textarea{color:inherit;font-family:inherit}
input::placeholder{color:${COLORS.dim}}
.mono{font-family:"Martian Mono","SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;letter-spacing:-.03em}
.wrap{max-width:1320px;margin:0 auto;padding:0 24px}
.wrap-narrow{max-width:880px;margin:0 auto;padding:0 24px}
.wrap-mid{max-width:1100px;margin:0 auto;padding:0 24px}
.dim{color:${COLORS.dim}}.muted{color:${COLORS.muted}}
.stack{display:flex;flex-direction:column}

/* header */
header.site{position:sticky;top:0;z-index:20;background:rgba(14,17,22,.86);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,.08)}
header.site .bar{max-width:1320px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px;flex:none;color:${COLORS.ink}}
.brand:hover{text-decoration:none}
.brand .dot{width:9px;height:9px;background:${COLORS.red}}
.brand span{font-family:"Martian Mono",monospace;font-weight:600;font-size:11px;letter-spacing:-.05em}
nav.main{display:flex;gap:2px;flex:1 1 220px;min-width:0;flex-wrap:wrap}
nav.main a{font-size:13px;font-weight:600;padding:7px 12px;border-radius:7px;color:${COLORS.muted};letter-spacing:-.01em}
nav.main a:hover{text-decoration:none;color:${COLORS.ink}}
nav.main a.on{color:${COLORS.ink};background:rgba(255,255,255,.08)}
.searchbox{display:flex;align-items:center;gap:8px;padding:7px 11px;border:1px solid rgba(255,255,255,.11);border-radius:7px;background:${COLORS.panel};flex:1 1 140px;min-width:0;max-width:220px}
.searchbox input{border:0;outline:0;background:transparent;font-size:12.5px;flex:1 1 60px;min-width:0;width:100%}
.btn{display:inline-block;padding:11px 18px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;border:1px solid transparent;text-align:center}
.btn:hover{text-decoration:none}
.btn-primary{background:${COLORS.accent};color:#fff}
.btn-primary:hover{background:#3A88E6;color:#fff}
.btn-ghost{border-color:rgba(255,255,255,.14);background:${COLORS.panel};color:${COLORS.ink}}
.btn-ghost:hover{border-color:rgba(255,255,255,.32);color:${COLORS.ink}}
.btn-sm{padding:8px 13px;font-size:12px}

/* hero */
.hero{padding:70px 0 46px;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:48px;align-items:end}
.hero h1{margin:0;font-size:clamp(36px,5vw,64px);line-height:.95;letter-spacing:-.05em;font-weight:800;text-wrap:balance}
.hero p.sub{margin:22px 0 0;font-size:17px;line-height:1.5;max-width:46ch;color:${COLORS.muted};text-wrap:pretty}
.eyebrow{font-family:"Martian Mono",monospace;font-size:9.5px;letter-spacing:.03em;color:${COLORS.dim};margin-bottom:20px}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden}
.statgrid .cell{background:${COLORS.panel};padding:20px 18px}
.statgrid .v{font-family:"Martian Mono",monospace;font-size:24px;font-weight:400;letter-spacing:-.07em}
.statgrid .l{font-size:11px;color:${COLORS.muted};margin-top:7px;line-height:1.35}

/* chips */
.chips{display:flex;gap:7px;flex-wrap:wrap;align-items:center;padding-bottom:22px;border-bottom:1px solid rgba(255,255,255,.08)}
.chip{font-family:"Martian Mono",monospace;font-size:9px;padding:7px 11px;border-radius:7px;letter-spacing:-.02em;background:transparent;color:${COLORS.muted};border:1px solid rgba(255,255,255,.11)}
.chip:hover{text-decoration:none;border-color:rgba(255,255,255,.3);color:${COLORS.ink}}
.chip.on{background:${COLORS.accent};color:#fff;border-color:${COLORS.accent}}

/* cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.card{display:flex;flex-direction:column;padding:20px;border:1px solid rgba(255,255,255,.09);border-radius:12px;background:${COLORS.panel};transition:.15s;color:inherit}
.card:hover{text-decoration:none;border-color:rgba(255,255,255,.24);transform:translateY(-2px)}
.card .top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.card .site{font-size:17px;font-weight:700;letter-spacing:-.028em;margin-top:16px}
.card .path{font-family:"Martian Mono",monospace;font-size:9.5px;color:${COLORS.dim};margin-top:4px;letter-spacing:-.02em;word-break:break-all}
.bigrow{display:flex;align-items:baseline;gap:11px;flex-wrap:wrap;margin-top:18px}
.bigrow .was{font-family:"Martian Mono",monospace;font-size:clamp(16px,4vw,24px);letter-spacing:-.06em;color:${COLORS.dim};text-decoration:line-through;text-decoration-thickness:2px}
.bigrow .now{font-family:"Martian Mono",monospace;font-size:clamp(18px,4.4vw,28px);letter-spacing:-.06em;font-weight:500}
.bigrow .arrow{color:${COLORS.dim};font-size:16px}
.delta{font-family:"Martian Mono",monospace;font-size:11px;padding:3px 7px;border-radius:5px}
.card .summary{font-size:13.5px;line-height:1.5;color:${COLORS.muted};margin-top:14px;flex:1;text-wrap:pretty}
.card .foot{display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07)}
.meter{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.09);overflow:hidden}
.meter i{display:block;height:100%}
.badge{font-family:"Martian Mono",monospace;font-size:8.5px;font-weight:500;letter-spacing:.03em;padding:5px 8px;border-radius:6px;display:inline-block;width:fit-content}
.badge.lg{font-size:10px;padding:6px 11px}

/* sections */
.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:22px 0 18px}
.sec-head h2{margin:0;font-size:15px;font-weight:700;letter-spacing:-.02em}
.label{font-family:"Martian Mono",monospace;font-size:9px;color:${COLORS.dim}}
.panel{border:1px solid rgba(255,255,255,.09);border-radius:12px;background:${COLORS.panel}}
.panel-pad{padding:20px}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.09);border-radius:12px;overflow:hidden}
.split>div{background:${COLORS.panel};padding:32px 28px;min-width:0}
.split>div.after{background:${COLORS.panelAlt}}
.hero-num{font-family:"Martian Mono",monospace;font-size:clamp(26px,6.5vw,46px);letter-spacing:-.08em;margin-top:10px;word-break:break-word}
.strike{color:#707A88;text-decoration:line-through;text-decoration-thickness:2px}

/* change page */
h1.change{margin:16px 0 0;font-size:clamp(28px,5vw,48px);line-height:1.02;letter-spacing:-.045em;font-weight:800;text-wrap:balance}
.meta-row{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:20px}
.rule{border:0;border-top:1px solid rgba(255,255,255,.09);margin:0}
.proof{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1px;background:rgba(255,255,255,.08)}
.proof>div{background:${COLORS.panel};padding:18px 20px;min-width:0}
.proof .v{font-family:"Martian Mono",monospace;font-size:11px;margin-top:8px;word-break:break-all;line-height:1.55;color:#C9D2DE}
.signal-row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.055);font-size:12.5px;color:${COLORS.muted}}
.signal-row:last-child{border-bottom:0}

/* diff */
.difftable{border:1px solid rgba(255,255,255,.1);border-radius:11px;overflow:hidden;background:#12161C}
.diffhead{display:flex;background:${COLORS.panelAlt};border-bottom:1px solid rgba(255,255,255,.08)}
.diffhead>div{flex:1;padding:11px 16px;font-family:"Martian Mono",monospace;font-size:9px;color:${COLORS.muted};min-width:0;word-break:break-all}
.diffhead>div:first-child{border-right:1px solid rgba(255,255,255,.08)}
.hunk{font-family:"Martian Mono",monospace;font-size:9px;color:${COLORS.dim};background:rgba(255,255,255,.03);padding:6px 16px;border-bottom:1px solid rgba(255,255,255,.05)}
.diffrow{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid rgba(255,255,255,.045)}
.cell{font-family:"Martian Mono",monospace;font-size:11px;line-height:1.9;padding:3px 14px;white-space:pre-wrap;word-break:break-word;min-width:0;color:#7E8996}
.cell .ln{display:inline-block;width:30px;color:#77838F;user-select:none}
.cell.del{background:rgba(242,84,91,.10);color:#FF9BA0}
.cell.add{background:rgba(63,191,127,.11);color:#7FE0AE}
.cell.blank{background:rgba(255,255,255,.02)}
.cell ins{background:rgba(63,191,127,.22);color:#B6F5D3;text-decoration:none;border-radius:2px}
.cell del{background:rgba(242,84,91,.22);color:#FFC0C4;text-decoration:none;border-radius:2px}
.diffstats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;padding:18px 0}
.diffstats .s{padding:14px 16px;border:1px solid rgba(255,255,255,.09);border-radius:9px;background:${COLORS.panel};display:flex;align-items:baseline;gap:10px}
.diffstats .s b{font-family:"Martian Mono",monospace;font-size:20px;letter-spacing:-.06em;font-weight:400}
.cols{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.col-main{flex:999 1 340px;min-width:0}
.col-side{flex:1 1 250px;min-width:0;display:flex;flex-direction:column;gap:14px}

/* tables & rows */
.rowlist{border:1px solid rgba(255,255,255,.09);border-radius:11px;overflow:hidden;background:${COLORS.panel}}
.rowhead{display:flex;gap:14px;padding:11px 18px;background:${COLORS.panelAlt};border-bottom:1px solid rgba(255,255,255,.08);font-family:"Martian Mono",monospace;font-size:8.5px;color:${COLORS.dim}}
.row{display:flex;gap:14px;padding:13px 18px;border-bottom:1px solid rgba(255,255,255,.05);align-items:center;flex-wrap:wrap;color:inherit}
.row:last-child{border-bottom:0}
a.row:hover{text-decoration:none;background:rgba(255,255,255,.025)}
.ledger{display:flex;gap:14px;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.05);align-items:center;flex-wrap:wrap;font-family:"Martian Mono",monospace;font-size:10.5px}
.timeline{display:flex;gap:18px;padding:18px 0;border-bottom:1px solid rgba(255,255,255,.055);flex-wrap:wrap;color:inherit}
a.timeline:hover{text-decoration:none;background:rgba(255,255,255,.022)}
.spark{display:flex;align-items:flex-end;gap:3px;height:78px}
.spark i{flex:1;min-height:3px;display:block}

/* forms */
.field{padding:11px 13px;border:1px solid rgba(255,255,255,.12);border-radius:7px;font-size:13px;outline:0;background:${COLORS.bg};color:${COLORS.ink};min-width:0}
.field:focus{border-color:${COLORS.accent}}
.formrow{display:flex;gap:8px;flex-wrap:wrap}

/* share card (light) */
.paper{background:${COLORS.paper};color:${COLORS.paperInk};border-radius:12px;overflow:hidden;padding:40px 36px}
.paper .brandline{display:flex;align-items:center;gap:8px}
.paper .brandline .dot{width:9px;height:9px;background:#D63B42}
.paper .brandline span{font-family:"Martian Mono",monospace;font-size:9px;letter-spacing:.07em;color:#5B6068}
.paper h2{margin:26px 0 0;font-size:clamp(26px,5vw,40px);line-height:1.03;letter-spacing:-.045em;font-weight:800}
.paper .row{border-bottom:1px solid rgba(0,0,0,.1);color:inherit}
.paper a{color:#16181C}

footer.site{margin-top:80px;border-top:1px solid rgba(255,255,255,.08);padding:28px 0 60px}
footer.site .inner{display:flex;gap:18px;flex-wrap:wrap;justify-content:space-between;font-size:12.5px;color:${COLORS.muted}}
.notice{padding:14px 16px;border:1px solid rgba(233,161,59,.3);background:rgba(233,161,59,.08);border-radius:9px;font-size:13px;color:#F0C078}
.empty{padding:48px 20px;text-align:center;font-size:13.5px;color:${COLORS.dim}}
@media(max-width:640px){
  .wrap,.wrap-narrow,.wrap-mid{padding:0 16px}
  .hero{padding:40px 0 30px;gap:28px}
  .split>div{padding:22px 18px}
  .diffrow{grid-template-columns:1fr}
  .diffrow .cell:first-child{border-bottom:1px solid rgba(255,255,255,.04)}
}
`;
