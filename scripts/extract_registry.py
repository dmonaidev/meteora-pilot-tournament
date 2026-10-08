"""Read the provided XLSX without editing it; emit a private normalized import."""
import json
from pathlib import Path
import openpyxl

source=Path('Метеора_Union_реестр_02-10-2026_v3.xlsx')
workbook=openpyxl.load_workbook(source,read_only=True,data_only=True)
sheet=workbook['Реестр']
iterator=sheet.iter_rows(values_only=True)
headers=[str(v).strip() if v is not None else '' for v in next(iterator)]
required=['Telegram ID','TLG_UserName','CommunityEcosystem','MeteoraPlus','MeteoraPro','Роль','Примечание']
if not all(v in headers for v in required):raise ValueError('Unexpected registry headers')
items={}
bad=[]
duplicates=[]
blank=0
def text(value):
    return None if value is None or str(value).strip()=='' else str(value).strip()
for row_number,values in enumerate(iterator,2):
    row=dict(zip(headers,values))
    if all(v is None for v in values):blank+=1;continue
    raw=row.get('Telegram ID')
    try:
        if isinstance(raw,bool):raise ValueError()
        tid=int(raw)
        if isinstance(raw,float) and raw!=tid:raise ValueError()
        if not 0<tid<=9007199254740991:raise ValueError()
    except (ValueError,TypeError,OverflowError):bad.append(row_number);continue
    username=text(row.get('TLG_UserName'))
    if username:username=username.removeprefix('@') or None
    item={'tg_id':tid,'tg_username':username,'group_name':text(row.get('Роль')) or 'Участник реестра','CommunityEcosystem':text(row.get('CommunityEcosystem')),'MeteoraPlus':text(row.get('MeteoraPlus')),'MeteoraPro':text(row.get('MeteoraPro')),'system_notes':text(row.get('Примечание'))}
    if tid in items:
        if items[tid]!=item:raise ValueError(f'Conflicting duplicate at source row {row_number}')
        duplicates.append(row_number)
    else:items[tid]=item
if bad:raise ValueError(f'Invalid Telegram IDs at rows {bad}')
Path('.local').mkdir(exist_ok=True)
Path('.local/initial-users.json').write_text(json.dumps({'rows':list(items.values())},ensure_ascii=False),encoding='utf-8')
print(json.dumps({'sheet':sheet.title,'valid_unique_rows':len(items),'identical_duplicate_rows':duplicates,'blank_rows':blank,'invalid_rows':bad},ensure_ascii=False))
