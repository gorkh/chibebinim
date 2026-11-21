const properties={person:"P4985",movie:"P4947",tv:"P4983"};
async function request(parameters) {
  const url=new URL("https://www.wikidata.org/w/api.php");
  url.search=new URLSearchParams({format:"json",...parameters});
  const response=await fetch(url.href,{
    headers:{"User-Agent":"Chibebinim/1.0 (https://github.com/gorkh/chibebinim)"},
    signal:AbortSignal.timeout(5000),redirect:"error",
  });
  if (!response.ok) throw new Error("Name knowledge unavailable");
  const value=await response.json();
  if (value.error) throw new Error("Name knowledge unavailable");
  return value;
}
export async function knowledgeNames(name,kind) {
  const search=await request({action:"wbsearchentities",search:name,language:"fa",uselang:"en",type:"item",limit:"4"});
  const ids=(search.search ?? []).map(item=>item.id).filter(id=>/^Q\d+$/u.test(id));
  if (!ids.length) return [];
  const response=await request({action:"wbgetentities",ids:ids.join("|"),props:"labels|claims",languages:"en"});
  return [...new Set(Object.values(response.entities ?? {}).filter(entity=>
    (entity.claims?.[properties[kind]] ?? []).some(claim=>
      claim.rank!=="deprecated" && /^[1-9]\d*$/u.test(claim.mainsnak?.datavalue?.value ?? "")))
    .map(entity=>entity.labels?.en?.value).filter(value=>typeof value==="string" && value.length<=140))].slice(0,3);
}
