// Español escrito -> fonemas para Kokoro (acento latinoamericano: c/z suenan como s).
// El español se lee casi como se escribe, así que bastan reglas; imita la salida de espeak-ng "es-419".

const UNIDADES = ['cero','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','once','doce','trece','catorce','quince',
  'dieciséis','diecisiete','dieciocho','diecinueve','veinte','veintiuno','veintidós','veintitrés','veinticuatro','veinticinco',
  'veintiséis','veintisiete','veintiocho','veintinueve'];
const DECENAS = ['','','','treinta','cuarenta','cincuenta','sesenta','setenta','ochenta','noventa'];
const CENTENAS = ['','ciento','doscientos','trescientos','cuatrocientos','quinientos','seiscientos','setecientos','ochocientos','novecientos'];

function menosDeMil(n){
  if(n < 30) return UNIDADES[n];
  if(n < 100){ const d = Math.floor(n/10), u = n%10; return DECENAS[d] + (u ? ' y ' + UNIDADES[u] : ''); }
  if(n === 100) return 'cien';
  const c = Math.floor(n/100), r = n%100;
  return CENTENAS[c] + (r ? ' ' + menosDeMil(r) : '');
}
export function numeroEnPalabras(n){
  if(!Number.isFinite(n) || n < 0 || n > 999999999999) return String(n);
  if(n < 1000) return menosDeMil(n);
  if(n < 1000000){
    const m = Math.floor(n/1000), r = n%1000;
    return (m === 1 ? 'mil' : menosDeMil(m).replace(/uno$/,'ún') + ' mil') + (r ? ' ' + menosDeMil(r) : '');
  }
  const mm = Math.floor(n/1000000), r = n%1000000;
  return (mm === 1 ? 'un millón' : numeroEnPalabras(mm).replace(/uno$/,'ún') + ' millones') + (r ? ' ' + numeroEnPalabras(r) : '');
}
const ORDINALES = ['','primero','segundo','tercero','cuarto','quinto','sexto','séptimo','octavo','noveno','décimo'];

const ABREV = [
  [/\bart(?:s)?\.\s*/gi, m => /s\./i.test(m) ? 'artículos ' : 'artículo '],
  [/\binc\.\s*/gi, 'inciso '], [/\bN[°º]\s*/g, 'número '], [/\bn[°º]\s*/g, 'número '], [/\bnúm\.\s*/gi, 'número '],
  [/\bSr\.\s*/g, 'señor '], [/\bSra\.\s*/g, 'señora '], [/\bDr\.\s*/g, 'doctor '], [/\bDra\.\s*/g, 'doctora '],
  [/\bpágs?\.\s*/gi, 'página '], [/\betc\./gi, 'etcétera'], [/\bD\.F\.L\.\s*/g, 'de efe ele '], [/\bD\.S\.\s*/g, 'de ese '],
  [/\bUd\./g, 'usted'], [/\bUds\./g, 'ustedes'], [/\bEE\.\s?UU\./g, 'Estados Unidos'], [/%/g, ' por ciento'], [/\$/g, ' pesos '],
  [/&/g, ' y '], [/§/g, ' párrafo '],
];

export function normalizarEs(t){
  for(const [re, rep] of ABREV) t = t.replace(re, rep);
  t = t.replace(/\b(\d{1,2})\s?[°º]/g, (m, d) => (ORDINALES[+d] || numeroEnPalabras(+d)) + ' ');
  t = t.replace(/\b\d{1,3}(?:\.\d{3})+\b/g, m => m.replace(/\./g, ''));       // 19.628 -> 19628
  t = t.replace(/(\d+),(\d+)/g, (m, a, b) => `${a} coma ${b}`);
  t = t.replace(/\d+/g, m => ' ' + numeroEnPalabras(parseInt(m, 10)) + ' ');
  t = t.replace(/[«»“”"]/g, '"').replace(/[–—]/g, ', ').replace(/[()\[\]]/g, ', ');
  return t.replace(/\s+/g, ' ').trim();
}

const VOC = 'aeiouáéíóúü';
const FUERTE = 'aeoáéóíú';           // las acentuadas cuentan como núcleo propio (hiato)
const isV = c => c && VOC.includes(c);
const sinTilde = c => ({'á':'a','é':'e','í':'i','ó':'o','ú':'u','ü':'u'})[c] || c;

// Divide una palabra en núcleos vocálicos para ubicar el acento.
function nucleos(w){
  const out = [];
  for(let i = 0; i < w.length; i++){
    if(!isV(w[i])) continue;
    // "qu" y "gu" + e/i: la u no suena, no es núcleo
    if(w[i] === 'u' && (w[i-1] === 'q' || w[i-1] === 'g') && 'eéií'.includes(w[i+1] || '')) continue;
    let j = i;
    while(isV(w[j+1])){
      const a = w[j], b = w[j+1];
      const debilA = 'iuü'.includes(a), debilB = 'iu'.includes(b);
      if(FUERTE.includes(a) && FUERTE.includes(b)) break;   // hiato: dos fuertes
      if(!debilA && !debilB) break;
      j++;
    }
    out.push([i, j]);
    i = j;
  }
  return out;
}
function silabaTonica(w){
  const ns = nucleos(w);
  if(!ns.length) return null;
  for(let k = 0; k < ns.length; k++){
    for(let i = ns[k][0]; i <= ns[k][1]; i++) if('áéíóú'.includes(w[i])) return {n: ns[k], vocal: i};
  }
  const ult = w[w.length-1];
  const k = (ns.length === 1) ? 0 : ('aeiouns'.includes(ult) ? ns.length - 2 : ns.length - 1);
  const [a, b] = ns[k];
  // dentro del núcleo, el acento va en la vocal fuerte (o en la segunda si son dos débiles: "cuida")
  let v = a;
  for(let i = a; i <= b; i++) if('aeo'.includes(w[i])){ v = i; break; }
  if(v === a && b > a && 'iuü'.includes(w[a]) && 'iu'.includes(w[b])) v = b;
  return {n: [a, b], vocal: v};
}

const ATONAS = new Set('el la los las lo le les de del a al en y e o u con por para sin se me te nos que su sus mi mis tu tus un una unos unas'.split(' '));

function palabra(w, antes){
  // b/d/g suenan fuertes solo tras pausa o nasal (y d tras l), también entre palabras
  const pausa = !antes || /[;:,.!?…"]/.test(antes);
  const acento = ATONAS.has(w) && !/[áéíóú]/.test(w) ? null : silabaTonica(w);
  let out = '';
  const at = (i) => w[i] || '';
  for(let i = 0; i < w.length; i++){
    const c = w[i], n = at(i+1), p = at(i-1);
    const inicio = i === 0;
    if(acento && i === acento.vocal) out += 'ˈ';
    if(isV(c)){
      const base = sinTilde(c);
      // i/u átonas junto a otra vocal del mismo núcleo -> semivocal
      const vecina = isV(n) || isV(p);
      if((c === 'i' || c === 'u' || c === 'ü') && vecina && !(acento && i === acento.vocal)){
        if(c === 'u' && (p === 'q' || p === 'g') && 'eéií'.includes(n)) continue;       // que, gui
        const antes = isV(n);   // "ia", "ue": semivocal antes del núcleo
        if(base === 'i') out += antes ? 'j' : 'i';
        else out += antes ? 'w' : 'u';
        continue;
      }
      out += base;
      continue;
    }
    switch(c){
      case 'b': case 'v': out += ((inicio && (pausa || 'mnŋ'.includes(antes))) || (!inicio && 'mn'.includes(p))) ? 'b' : 'β'; break;
      case 'd': out += ((inicio && (pausa || 'nlŋ'.includes(antes))) || (!inicio && 'nl'.includes(p))) ? 'd' : 'ð'; break;
      case 'g':
        if('eéií'.includes(n)) out += 'x';
        else out += ((inicio && (pausa || 'nŋ'.includes(antes))) || (!inicio && p === 'n')) ? 'ɡ' : 'ɣ';
        break;
      case 'c':
        if(n === 'h'){ out += 'ʧ'; i++; }
        else if('eéií'.includes(n)) out += 's';
        else out += 'k';
        break;
      case 'q': out += 'k'; break;
      case 'z': out += 's'; break;
      case 'j': out += 'x'; break;
      case 'h': break;
      case 'l': if(n === 'l'){ out += 'ʝ'; i++; } else out += 'l'; break;
      case 'y':
        if(!isV(n)){                                   // "y" final o sola suena como vocal
          if(i === w.length-1 && isV(p)){
            const d = sinTilde(p);
            out = out.slice(0, -1) + ({a:'I', e:'A', o:'oɪ', u:'ui'}[d] || d + 'i');
          } else out += 'i';
        } else out += 'ʝ';
        break;
      case 'ñ': out += 'ɲ'; break;
      case 'r':
        if(n === 'r'){ out += 'r'; i++; }
        else out += (inicio || 'nls'.includes(p)) ? 'r' : 'ɾ';
        break;
      case 'x': out += inicio ? 's' : 'ks'; break;
      case 'w': out += 'w'; break;
      case 'k': out += 'k'; break;
      case 'n': out += (n === 'g' || n === 'k' || (n === 'c' && !'eéií'.includes(at(i+2)))) ? 'ŋ' : 'n'; break;
      default: out += c;
    }
  }
  // diptongos que Kokoro escribe con una sola letra
  out = out.replace(/ai(?=[^aeiou]|$)/g, 'I').replace(/ei(?=[^aeiou]|$)/g, 'A').replace(/au(?=[^aeiou]|$)/g, 'W');
  return out;
}

// Deletrea siglas en mayúsculas (BCN -> be ce ene)
const LETRAS = {a:'a',b:'be',c:'ce',d:'de',e:'e',f:'efe',g:'ge',h:'hache',i:'i',j:'jota',k:'ka',l:'ele',m:'eme',n:'ene',ñ:'eñe',o:'o',p:'pe',q:'cu',r:'erre',s:'ese',t:'te',u:'u',v:'uve',w:'doble uve',x:'equis',y:'ye',z:'zeta'};

export function fonemasEs(texto){
  const t = normalizarEs(texto)
    .replace(/\b([A-ZÑ]{2,5})\b/g, (m) => /[AEIOU]/.test(m) && m.length > 3 ? m : m.toLowerCase().split('').map(l => LETRAS[l] || l).join(' '));
  let antes = '';
  return t.toLowerCase().split(/([^a-záéíóúüñ]+)/).map(seg => {
    if(!seg) return '';
    if(/^[a-záéíóúüñ]+$/.test(seg)){ const f = palabra(seg, antes); antes = f.replace(/ˈ/g, '').slice(-1); return f; }
    const r = seg.replace(/[¿¡]/g, '').replace(/[^;:,.!?…" ]/g, ' ');
    if(/[;:,.!?…"]/.test(r)) antes = '.';
    return r;
  }).join('').replace(/\s+/g, ' ').trim();
}
