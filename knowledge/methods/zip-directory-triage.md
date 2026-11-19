# ZIP 目录与截断诊断

适用：ZIP 样本无法列目录、报告归档末尾异常，或只找到 PK 文件头。

分析和验证：对普通单卷 ZIP，从文件尾查找 EOCD 候选，核对固定字段与注释长度，再验证中央目录偏移、长度及记录是否落在文件范围内。随机出现的 PK 字节串可能是正文或注释。保留候选偏移、声明目录范围和实际文件长度。

失败分流：目录偏移越界或尾部记录不完整时，优先查截断、尾部附加数据与分卷。ZIP64 哨兵值要结合 ZIP64 记录解释。仅凭本地文件头无法证明中央目录完整，也无法判定口令是报错原因。保持原件只读。

质量：规范核对的独立笔记。来源：[Des-CTF-Knowledge 压缩包总结](https://github.com/Dest1ny-Sec/Des-CTF-Knowledge/blob/main/压缩包总结.md) · [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/APPNOTE/APPNOTE-6.2.0.txt)
