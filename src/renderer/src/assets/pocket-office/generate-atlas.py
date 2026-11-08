"""Original Pocket Office pixel atlas. Requires Pillow; run from any directory."""
from pathlib import Path
import json
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
PALETTES = {
    'neutral': ['#242a2a', '#65706c', '#aab4a4', '#e4ead5'],
    'green': ['#203c31', '#496b47', '#91ac70', '#d8e5b5'],
    'color': ['#30283a', '#a86845', '#dfb67c', '#f5e4bc'],
}
DIRS = ['down', 'left', 'right', 'up']
POSES = ['idle', 'walk-1', 'walk-2', 'work', 'wait', 'done', 'error']
SILHOUETTES = ['crop', 'part', 'bun', 'wide', 'long', 'cap']
PROPS = ['desk', 'desk-wide', 'crt', 'crt-side', 'chair', 'chair-side', 'shelf', 'cabinet', 'plant', 'plant-tall', 'meeting-table', 'coffee-station', 'mug', 'partition']

def box(d, xy, fill): d.rectangle(xy, fill=fill)

def worker(sil, direction, pose):
    im = Image.new('P', (16, 24), 255); d = ImageDraw.Draw(im)
    # Feet alternate without moving the common pivot; no time-based idle loop.
    if pose == 'walk-1':
        box(d, (3, 19, 6, 22), 0); box(d, (9, 18, 12, 21), 0)
    elif pose == 'walk-2':
        box(d, (4, 18, 7, 21), 0); box(d, (10, 19, 13, 22), 0)
    else:
        box(d, (4, 19, 7, 22), 0); box(d, (9, 19, 12, 22), 0)
    box(d, (3, 10, 12, 19), 0); box(d, (4, 11, 11, 18), 1)
    if sil in ('part', 'long'): box(d, (7, 11, 8, 17), 3)
    if sil in ('wide', 'cap'): box(d, (4, 14, 11, 15), 2)
    box(d, (4, 2, 11, 9), 0); box(d, (5, 4, 10, 8), 2)
    if direction == 'up': box(d, (5, 3, 10, 8), 0)
    elif direction == 'left': box(d, (4, 5, 5, 6), 2); box(d, (8, 5, 8, 5), 0)
    elif direction == 'right': box(d, (10, 5, 11, 6), 2); box(d, (7, 5, 7, 5), 0)
    else: box(d, (6, 6, 6, 6), 0); box(d, (9, 6, 9, 6), 0)
    if sil == 'crop': box(d, (4, 1, 11, 3), 0)
    if sil == 'part': box(d, (3, 1, 11, 3), 0); box(d, (3, 3, 4, 7), 0)
    if sil == 'bun': box(d, (5, 0, 10, 3), 0); box(d, (7, 0, 9, 0), 1)
    if sil == 'wide': box(d, (2, 2, 13, 4), 0); box(d, (3, 5, 4, 7), 0)
    if sil == 'long': box(d, (3, 2, 12, 4), 0); box(d, (3, 4, 4, 10), 0); box(d, (11, 4, 12, 10), 0)
    if sil == 'cap': box(d, (3, 1, 12, 3), 0); box(d, (5, 1, 10, 1), 2)
    if pose == 'work': box(d, (1, 13, 4, 15), 0); box(d, (11, 13, 14, 15), 0)
    if pose == 'wait': box(d, (2, 12, 4, 18), 0); box(d, (11, 12, 13, 18), 0)
    if pose == 'done': box(d, (0, 9, 4, 11), 0); box(d, (11, 9, 15, 11), 0)
    if pose == 'error': box(d, (2, 11, 5, 13), 0); box(d, (10, 11, 13, 13), 0)
    return im

def tile(i):
    im = Image.new('P', (16, 16), 3); d = ImageDraw.Draw(im)
    kind = i // 8; v = i % 8
    if kind == 0: # floor: sparse seams, variations align on tile edges
        if v in (1, 3): box(d, (0, 15, 15, 15), 2)
        if v in (2, 3): box(d, (15, 0, 15, 15), 2)
        if v >= 4: box(d, (2+v, 4, 2+v, 4), 2)
    elif kind == 1: # walls and corners
        box(d, (0, 0, 15, 5), 1); box(d, (0, 6, 15, 7), 0)
        if v & 1: box(d, (0, 0, 1, 15), 0)
        if v & 2: box(d, (14, 0, 15, 15), 0)
    elif kind == 2: # rugs
        box(d, (0, 0, 15, 15), 2); box(d, (2, 2, 13, 13), 1)
        if v & 1: box(d, (4, 4, 11, 11), 2)
        if v & 2: box(d, (7, 3, 8, 12), 3)
    elif kind == 3: # doors
        box(d, (2, 0, 13, 15), 0); box(d, (4, 1, 11, 14), 2); box(d, (9, 8, 10, 9), 0)
        if v & 1: box(d, (4, 2, 11, 4), 1)
    elif kind == 4: # partitions
        box(d, (0, 4, 15, 11), 0); box(d, (0, 5, 15, 9), 2)
        if v & 1: box(d, (7, 5, 8, 9), 1)
    else: # floor details
        box(d, (3, 3, 12, 12), 2)
        if v & 1: box(d, (5, 5, 10, 10), 3)
        if v & 2: box(d, (7, 4, 8, 11), 1)
    return im

def prop(i):
    im = Image.new('P', (32, 32), 255); d = ImageDraw.Draw(im)
    if i in (0, 1): # desks
        box(d, (1, 5, 30, 23), 0); box(d, (2, 6, 29, 19), 2); box(d, (3, 20, 28, 22), 1)
        box(d, (4, 23, 6, 27), 0); box(d, (25, 23, 27, 27), 0)
        if i == 1: box(d, (3, 8, 28, 9), 3)
    elif i in (2, 3): # CRT with casing, screen, stand and side depth
        box(d, (5, 4, 26, 20), 0); box(d, (7, 6, 23, 17), 1); box(d, (9, 7, 21, 14), 2)
        box(d, (10, 8, 17, 8), 3); box(d, (24, 6, 25, 18), 2); box(d, (12, 21, 19, 23), 0); box(d, (9, 24, 22, 25), 0)
        if i == 3: box(d, (22, 7, 25, 16), 1)
    elif i in (4, 5):
        box(d, (8, 4, 23, 12), 0); box(d, (10, 6, 21, 10), 1); box(d, (7, 13, 24, 22), 0); box(d, (9, 14, 22, 19), 2); box(d, (14, 23, 17, 27), 0); box(d, (10, 27, 21, 28), 0)
        if i == 5: box(d, (20, 7, 24, 20), 1)
    elif i in (6, 7):
        box(d, (4, 3, 27, 27), 0); box(d, (6, 5, 25, 25), 1)
        for y in (10, 17, 24): box(d, (6, y, 25, y+1), 0)
        for x in (8, 12, 19): box(d, (x, 6, x+2, 9), 2)
        if i == 7: box(d, (8, 14, 23, 22), 2); box(d, (19, 17, 20, 18), 0)
    elif i in (8, 9):
        box(d, (11, 21, 20, 28), 0); box(d, (12, 22, 19, 26), 1); box(d, (14, 9, 17, 22), 0)
        box(d, (7, 7, 15, 15), 1); box(d, (17, 5, 24, 14), 0); box(d, (9, 8, 13, 12), 2); box(d, (19, 7, 22, 11), 2)
        if i == 9: box(d, (13, 2, 18, 10), 1)
    elif i == 10:
        box(d, (2, 7, 29, 24), 0); box(d, (4, 9, 27, 20), 2); box(d, (6, 25, 8, 28), 0); box(d, (23, 25, 25, 28), 0)
    elif i == 11:
        box(d, (2, 9, 29, 27), 0); box(d, (4, 11, 27, 23), 2); box(d, (7, 3, 18, 12), 0); box(d, (9, 5, 16, 9), 1); box(d, (21, 14, 25, 19), 0); box(d, (22, 15, 24, 18), 3)
    elif i == 12:
        box(d, (11, 12, 20, 22), 0); box(d, (13, 14, 18, 20), 3); box(d, (21, 14, 23, 19), 0)
    else:
        box(d, (2, 3, 29, 26), 0); box(d, (4, 5, 27, 23), 2); box(d, (15, 5, 16, 23), 1)
    return im

def save_sheet(name, image):
    for palette_name, colors in PALETTES.items():
        rgba = Image.new('RGBA', image.size, (0, 0, 0, 0))
        pixels = []
        for index, p in enumerate(image.getdata()):
            if p == 255:
                pixels.append((0,0,0,0)); continue
            x, y = index % image.width, index // image.width
            ramp = colors
            if palette_name == 'color':
                if name == 'tiles':
                    family = y // 16
                    ramp = [['#554037','#cda67c','#e6cba0','#f5e4bc'],['#493741','#977579','#d5b8a3','#f5e4bc'],['#49364b','#9d6170','#d7a28a','#f5e4bc'],['#48333a','#9d6146','#d9a77a','#f6dcad'],['#4a3c48','#9d7771','#d5bcb0','#f5e4bc'],['#51443b','#bc8d62','#e3c596','#f5e4bc']][family]
                elif name == 'props':
                    item = (y//32)*4+x//32
                    if item in (8,9): ramp = ['#31473a','#4f9255','#91c576','#e8e2ae']
                    elif item in (2,3): ramp = ['#303744','#687987','#8ed2c4','#e4f1d2']
                    elif item in (4,5): ramp = ['#473648','#a95c69','#db8991','#f5d5bc']
                    else: ramp = ['#493037','#a45f3d','#dfae76','#f9dfab']
                else:
                    sil = y//(24*4); local_y = y % 24
                    hair = ['#443037','#513a28','#8c4e35','#2f3944','#704330','#5d4a3a'][sil]
                    clothes = ['#467c9c','#b45d64','#749250','#aa7142','#786b9e','#447f76'][sil]
                    skin = ['#eac19a','#bf845f','#f0c9a2','#9f684e','#d6a17c','#efcfaa'][sil]
                    ramp = [hair, clothes, skin if local_y < 10 else '#c3d9c4', '#f5e4bc']
            value = ramp[p]
            pixels.append(tuple(bytes.fromhex(value[1:])) + (255,))
        rgba.putdata(pixels); rgba.save(HERE / f'{name}-{palette_name}.png', optimize=False)

frames = {}; props = {}; tiles = {}; workers = {}
sheet = Image.new('P', (128, 96), 255)
for i in range(48):
    x, y = (i % 8)*16, (i // 8)*16; sheet.paste(tile(i), (x,y)); name = f'tile.{i:02d}'; tiles[name] = {'x':x,'y':y,'w':16,'h':16}
save_sheet('tiles', sheet)
sheet = Image.new('P', (128, 128), 255)
for i, name in enumerate(PROPS):
    x,y=(i%4)*32,(i//4)*32; sheet.paste(prop(i),(x,y)); frames[f'prop.{name}']={'x':x,'y':y,'w':32,'h':32}
    props[name]={'frame':f'prop.{name}', 'placement':'tabletop' if name in ('crt','crt-side','mug') else 'floor', 'footprint':[[0,0],[1,0],[0,1],[1,1]], 'interactionAnchors':[{'cell':[0,2],'facing':'up'},{'cell':[1,2],'facing':'up'}], 'depthAnchor':[16,28]}
save_sheet('props',sheet)
sheet = Image.new('P', (16*7, 24*24), 255)
for s, sil in enumerate(SILHOUETTES):
    for di, direction in enumerate(DIRS):
        for pi, pose in enumerate(POSES):
            x,y=pi*16,(s*4+di)*24; sheet.paste(worker(sil,direction,pose),(x,y)); workers[f'worker.{sil}.{direction}.{pose}']={'x':x,'y':y,'w':16,'h':24}
save_sheet('workers',sheet)
metadata={'version':1,'tileSize':16,'palettes':PALETTES,'sheets':{'tiles':{'files':{p:f'tiles-{p}.png' for p in PALETTES},'frames':tiles},'props':{'files':{p:f'props-{p}.png' for p in PALETTES},'frames':frames},'workers':{'files':{p:f'workers-{p}.png' for p in PALETTES},'frames':workers}},'workerFeet':[8,23],'props':props}
(HERE/'atlas.json').write_text(json.dumps(metadata,indent=2)+'\n',encoding='utf-8')

# Four-worker review image, using the exact color sheet frames at 4× nearest-neighbor.
preview = Image.new('RGBA', (192,144), '#f5e4bc')
pd = ImageDraw.Draw(preview)
pd.rectangle((0,0,191,12), fill='#977579'); pd.rectangle((0,11,191,13), fill='#493741')
prop_sheet = Image.open(HERE/'props-color.png'); worker_sheet = Image.open(HERE/'workers-color.png')
def paste_frame(sheet, frame, xy):
    crop = sheet.crop((frame['x'], frame['y'], frame['x']+frame['w'], frame['y']+frame['h']))
    preview.alpha_composite(crop, xy)
for n, xy in [('shelf',(4,15)),('plant',(156,15)),('coffee-station',(145,103))]:
    paste_frame(prop_sheet, frames['prop.'+n], xy)
for i, (x,y) in enumerate([(42,23),(111,23),(42,87),(111,87)]):
    paste_frame(prop_sheet, frames['prop.desk'], (x,y))
    paste_frame(prop_sheet, frames['prop.crt'], (x,y-7))
    paste_frame(worker_sheet, workers[f'worker.{SILHOUETTES[i]}.down.idle'], (x+8,y+25))
preview.convert('RGB').resize((768,576), Image.Resampling.NEAREST).save(HERE/'review-color-vignette.png')
