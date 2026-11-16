"""PLANO B — remove a aba Hospedagem do Atlas de Bolso.

Uso:  python3 tools/plano-b.py [arquivo ...]
Sem argumentos, limpa public/index.html. Remove tudo que está entre os marcadores
/*LODGING*/ ... /*/LODGING*/ (JavaScript e CSS). O restante do app não muda.
Alternativa: restaurar a branch "antes-hospedagem" (estado do app antes da aba).
"""
import re, sys, pathlib
files = sys.argv[1:] or [str(pathlib.Path(__file__).resolve().parent.parent / "public" / "index.html")]
for f in files:
    p = pathlib.Path(f); s = p.read_text(encoding="utf-8")
    n = len(re.findall(r"/\*LODGING\*/", s))
    s2 = re.sub(r"/\*LODGING\*/.*?/\*/LODGING\*/\n?", "", s, flags=re.S)
    p.write_text(s2, encoding="utf-8")
    print(f"{f}: {n} blocos removidos")
