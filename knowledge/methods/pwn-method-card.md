# pwn 方法卡

识别二进制利用题。先哈希和辨认文件类型，再静态检查 ELF 架构、NX、PIE、RELRO 和 canary。工具候选为 readelf 和静态反汇编器。保存头字段与位置，交叉核对保护机制。避免把推断当事实。隔离验收前禁止动态运行不可信程序。

## ELF 保护属性的静态判读

想确认栈能否执行时，只读检查 GNU_STACK 程序头的执行标志。头部缺失时记录缺失，并结合目标平台判断。检查 RELRO 时分别记录 GNU_RELRO 段与立即绑定标记，例如 BIND_NOW。判断是否为位置无关可执行文件时，结合 ELF 类型、动态标志和解释器字段。共享库也可能使用 ET_DYN。保留字段值，便于复核工具给出的保护属性摘要。

参考：[LLVM llvm-readelf 文档](https://llvm.org/docs/CommandGuide/llvm-readelf.html)。
