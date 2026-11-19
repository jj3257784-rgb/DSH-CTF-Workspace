# misc 方法卡

识别文件、编码及元数据题。先记录原始 SHA-256 和文件类型，再用 Node Buffer 做受限转换。保留参数、来源和产物哈希。不要覆盖原始样本或执行附件。重放转换并比较产物哈希。

## pcapng 抓包截断

抓包里显示的数据比报文长度短时，先比较 Enhanced Packet Block 的 Captured Packet Length 与 Original Packet Length。前者更短表示该条记录只保存了原报文的一部分。再按同一 Section 内的 Interface ID 找到 Interface Description Block，核对链路类型与 snaplen。若多条记录在同一长度处截断，可记录这一规律和相关接口设置。区分单条报文被截断与整个抓包文件损坏。

参考：[Wireshark pcapng 读取实现](https://github.com/wireshark/wireshark/blob/master/wiretap/pcapng.c)。
