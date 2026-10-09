# Writes timetable-text.pdf: a one-page PDF whose timetable is real selectable text.
# Run: python3 make-timetable-pdf.py   (no dependencies)
lines = [
    (72, 760, "Grade 10A Timetable"),
    (72, 730, "Period"), (180, 730, "Monday"), (290, 730, "Tuesday"),
    (72, 705, "08:00"), (180, 705, "Mathematics"), (290, 705, "English"),
    (72, 680, "09:00"), (180, 680, "English"), (290, 680, "Mathematics"),
]
body = "\n".join("BT /F1 12 Tf %d %d Td (%s) Tj ET" % (x, y, t) for x, y, t in lines)
objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length %d >>\nstream\n%s\nendstream" % (len(body), body),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
out = "%PDF-1.4\n"; offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(out)); out += "%d 0 obj\n%s\nendobj\n" % (i, o)
x = len(out)
out += "xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offs: out += "%010d 00000 n \n" % o
out += "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
open("timetable-text.pdf", "w", encoding="latin-1").write(out)
print("wrote timetable-text.pdf")
