const normalize=value=>(value ?? "").normalize("NFKD").replace(/\p{M}/gu,"")
  .replaceAll("ي","ی").replaceAll("ك","ک").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
const distinct=rows=>[...new Map(rows.map(row=>[row.id,row])).values()];
const names=person=>[person.name,person.original_name,...(person.also_known_as ?? [])];
export const personMatches=(person,name)=>names(person).some(alias=>normalize(alias)===normalize(name));
export function personChoices(candidates,name,chosen) {
  const valid=distinct(candidates.filter(person=>!person.adult && Number.isSafeInteger(person.id) && person.id>0 && person.name));
  if (chosen) {
    const selected=valid.find(person=>person.id===Number(chosen));
    return selected ? {selected} : {missing:true};
  }
  const exact=valid.filter(person=>personMatches(person,name));
  const shortName=normalize(name).split(" ").length===1 && valid.length>1;
  if (exact.length===1 && !shortName) return {selected:exact[0]};
  const choices=(exact.length && !shortName ? exact : valid).sort((a,b)=>
    Number(b.known_for_department==="Directing")-Number(a.known_for_department==="Directing") ||
    (b.popularity ?? 0)-(a.popularity ?? 0)).slice(0,6);
  return choices.length ? {peopleChoices:choices} : {missing:true};
}

async function searchVariants(name,hint,search) {
  const variants=[...new Set([name,hint].filter(value=>typeof value==="string" && value.trim()))];
  const responses=await Promise.allSettled(variants.map(value=>search(value)));
  const rows=responses.filter(result=>result.status==="fulfilled").flatMap(result=>result.value);
  if (!rows.length && responses.some(result=>result.status==="rejected")) {
    throw responses.find(result=>result.status==="rejected").reason;
  }
  return distinct(rows);
}

export async function resolvePerson(get,name,hint,lookupNames) {
  let candidates=await searchVariants(name,hint,async query=>{
    const result=await get("search/person",{query,include_adult:"false"});
    return result.results ?? [];
  });
  const initial=personChoices(candidates,name);
  if (initial.selected) return initial;
  if (lookupNames && /\p{Script=Arabic}/u.test(name)) {
    let published=[];
    try {published=await lookupNames(name);}
    catch(error) {if (!candidates.length) throw error;}
    const extra=await Promise.allSettled(published.map(async query=>{
      const result=await get("search/person",{query,include_adult:"false"});
      return result.results ?? [];
    }));
    candidates=distinct([...candidates,...extra.filter(row=>row.status==="fulfilled").flatMap(row=>row.value)]);
    if (!candidates.length && extra.some(row=>row.status==="rejected")) throw extra.find(row=>row.status==="rejected").reason;
  }
  const expandedChoices=personChoices(candidates,name);
  if (expandedChoices.selected || !expandedChoices.peopleChoices) return expandedChoices;
  // Use aliases published by the catalog before asking the user to identify a candidate.
  const profiles=await Promise.allSettled(expandedChoices.peopleChoices.slice(0,4).map(person=>get("person/"+person.id)));
  const expanded=expandedChoices.peopleChoices.map((person,index)=>
    profiles[index]?.status==="fulfilled" ? {...person,...profiles[index].value} : person);
  return personChoices(expanded,name);
}

export async function resolveTitles(search,name,hint,kind,lookupNames) {
  const initial=await searchVariants(name,hint,async query=>search(query,kind));
  if (!lookupNames || !/\p{Script=Arabic}/u.test(name) ||
      initial.some(media=>[media.title,media.original_title,media.persian_title,...(media.aliases ?? [])]
        .some(title=>normalize(title)===normalize(name)))) return initial;
  let published=[];
  try {published=await lookupNames(name);}
  catch(error) {if (!initial.length) throw error;}
  const extra=await Promise.allSettled(published.map(query=>search(query,kind)));
  const result=distinct([...initial,...extra.filter(row=>row.status==="fulfilled").flatMap(row=>row.value)]);
  if (!result.length && extra.some(row=>row.status==="rejected")) throw extra.find(row=>row.status==="rejected").reason;
  return result;
}

export function personLabel(person) {
  const works=(person.known_for ?? []).slice(0,2).map(work=>work.title ?? work.name).filter(Boolean);
  const born=person.birthday?.slice(0,4);
  return [person.name,born ? "متولد "+born : "",works.join("، ")].filter(Boolean).join(" · ").slice(0,150);
}
