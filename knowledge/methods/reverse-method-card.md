# reverse 方法卡

识别需要还原程序逻辑的题目。先识别文件类型和字符串，再静态反编译并追踪控制流。工具候选为 strings 和反编译器。记录地址、分支与算法中间值。用固定输入复核静态推断，明确区分静态推断和动态事实。不可信样本需要隔离后才能运行。

## PE 文件头识别

Windows 可执行文件以 MZ 开头时，读取 DOS 头中的 e_lfanew。确认偏移及后续头部均在文件范围内，再核对 PE 签名、COFF Machine 字段和可选头 Magic。PE32 与 PE32+ 表示可选头格式，目标架构应以 Machine 字段为准。记录字段值和偏移以便复核。

参考：[Corkami 二进制格式图解](https://github.com/corkami/pics/tree/master/binary)。

## ELF 调试信息与符号表

程序只剩少量函数名，或反编译时看不到源码行号时，分别检查 DWARF 调试节、静态符号表和动态符号表。剥离了静态符号的文件可能仍保留动态符号。主文件里没有调试节时，记录这一观察，并检查是否有独立调试文件的线索。用节名和工具输出支持判断。

参考：[LLVM llvm-dwarfdump 文档](https://llvm.org/docs/CommandGuide/llvm-dwarfdump.html)。
