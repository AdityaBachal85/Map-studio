import collections, re
import xml.etree.ElementTree as ET
A='{http://schemas.openxmlformats.org/drawingml/2006/main}'
P='{http://schemas.openxmlformats.org/presentationml/2006/main}'
tree=ET.parse("unz/ppt/slides/slide1.xml"); root=tree.getroot()

# shape ids across ALL cNvPr (p namespace)
cnv=root.iter(P+'cNvPr')
rows=[(c.get('id'),c.get('name')) for c in cnv]
ids=[r[0] for r in rows]
print("=== p:cNvPr ids/names ===")
for r in rows: print("  id=%-4s name=%s"%r)
dup=[k for k,v in collections.Counter(ids).items() if v>1]
print("TOTAL:",len(ids)," DUPLICATE ids:",dup or "none"," id=='0' used:", '0' in ids, " ids start at:", sorted(set(int(i) for i in ids))[:3])

# walk top-level shapes in spTree, report tag + geom + name
print("\n=== spTree children (z-order) with geometry ===")
spTree=root.find(P+'cSld').find(P+'spTree')
def geom(el):
    xf=el.find('.//'+A+'xfrm')
    if xf is None: return "no-xfrm"
    off=xf.find(A+'off'); ext=xf.find(A+'ext')
    prst=el.find('.//'+A+'prstGeom')
    p = prst.get('prst') if prst is not None else '-'
    return "prst=%s off=(%s,%s) ext=(%s,%s)"%(p, off.get('x') if off is not None else '?', off.get('y') if off is not None else '?', ext.get('cx') if ext is not None else '?', ext.get('cy') if ext is not None else '?')
for ch in spTree:
    tag=ch.tag.split('}')[-1]
    if tag in ('nvGrpSpPr','grpSpPr'):
        print("  [%s]"%tag, geom(ch)); continue
    nv=ch.find('.//'+P+'cNvPr')
    nm = nv.get('name') if nv is not None else '-'
    idv = nv.get('id') if nv is not None else '-'
    print("  <%s> id=%s name=%r  %s"%(tag, idv, nm, geom(ch)))

# zero-extent lines: are they <p:sp> prstGeom line? show their spPr ln
print("\n=== shapes with cx==0 or cy==0 in ext ===")
for sp in spTree.iter(P+'sp'):
    ext=sp.find('.//'+A+'xfrm/'+A+'ext')
    if ext is None: continue
    cx,cy=int(ext.get('cx')),int(ext.get('cy'))
    if cx==0 or cy==0:
        prst=sp.find('.//'+A+'prstGeom')
        nv=sp.find('.//'+P+'cNvPr')
        print("  name=%r prst=%s ext=(%d,%d)"%(nv.get('name'), prst.get('prst') if prst is not None else '?', cx, cy))
