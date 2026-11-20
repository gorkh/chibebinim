// Qualitative preferences use catalog tags and a small editorial seed set.
// They are approximate descriptions, not factual claims about a viewer's feelings.
export const moods = {
  uplifting: {label:"امیدبخش",terms:["hope","inspirational","perseverance"],
    seeds:[["The Shawshank Redemption","movie",1994],["The Pursuit of Happyness","movie",2006],["Ted Lasso","tv",2020]]},
  eerie: {label:"وهم‌انگیز",terms:["haunted house","psychological horror","ghost story","surrealism"],
    seeds:[["The Others","movie",2001],["Twin Peaks","tv",1990]]},
  dark: {label:"تاریک",terms:["dystopia","neo-noir","psychological thriller"],
    seeds:[["Se7en","movie",1995],["Dark","tv",2017]]},
  light: {label:"سبک و سرحال",terms:["feel good","lighthearted","comedy"],
    seeds:[["Paddington 2","movie",2017],["The Good Place","tv",2016]]},
  intense: {label:"پرتنش",terms:["suspense","psychological thriller","survival"],
    seeds:[["Whiplash","movie",2014],["Severance","tv",2022]]},
};
export const themes = {
  teen: {label:"نوجوانانه",terms:["teenager","coming of age","high school"],
    seeds:[["The Perks of Being a Wallflower","movie",2012],["Sex Education","tv",2019]]},
  geek: {label:"گیک‌طوری",terms:["nerd","geek","video game","computer programmer"],
    seeds:[["Scott Pilgrim vs. the World","movie",2010],["The IT Crowd","tv",2006]]},
  technology: {label:"فناوری",terms:["technology","artificial intelligence","hacker","computer"],
    seeds:[["The Matrix","movie",1999],["Ex Machina","movie",2015],["Black Mirror","tv",2011]]},
  space: {label:"فضا و سفر فضایی",terms:["space travel","space exploration","astronaut"],
    seeds:[["Interstellar","movie",2014],["The Expanse","tv",2015]]},
  friendship: {label:"دوستی",terms:["friendship","best friend"],
    seeds:[["Stand by Me","movie",1986],["Friends","tv",1994]]},
};
const normalize = value => (value ?? "").normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
export const preferences = query => [
  ...(query.moods ?? []).map(key=>({key:"mood:"+key,...moods[key]})),
  ...(query.themes ?? []).map(key=>({key:"theme:"+key,...themes[key]})),
];
export function semanticTags(media) {
  const tags=new Set((media.keywords ?? []).map(normalize));
  return [...Object.entries(moods).map(([key,value])=>["mood:"+key,value]),
    ...Object.entries(themes).map(([key,value])=>["theme:"+key,value])]
    .filter(([,value])=>value.terms.some(term=>tags.has(normalize(term))) ||
      value.seeds.some(([title,type,year])=>normalize(title)===normalize(media.title) &&
        type===media.media_type && year===Number(media.release_date?.slice(0,4))))
    .map(([key])=>key);
}
export function matchesPreferences(media,query) {
  const selected=preferences(query);
  if (!selected.length) return true;
  const tags=semanticTags(media);
  return selected.every(item=>tags.includes(item.key));
}
export function editorialPreferenceScore(media,query) {
  return preferences(query).filter(item=>item.seeds.some(([title,type,year])=>
    normalize(title)===normalize(media.title) && type===media.media_type &&
    year===Number(media.release_date?.slice(0,4)))).length;
}
