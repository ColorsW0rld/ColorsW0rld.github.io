# ColorsW0rld.github.io

#### 使用工具
step1 **Chrome插件 Save Page WE** 保存网页到本地
step2 批量重命名文件，并且拖动到对应年份的文件夹（./artical/${year})
step3 在index.html中，加入对应文件索引

其中，批量重命名代码和索引生成代码如下，运行后可以直接Ctrl-c，Ctrl-v
```bash
# 重命名文件名，添加ColorsWorld_日期_原始标题
grep -Hnr "publish_time" *| awk -F"(:)|(>)|(<)" '{print "mv " "\"" $1 "\"" " \"ColorsWorld_" $5 "_" $1 "\" "}' > rename.sh
sh rename.sh
# 对当前目录下重命名的html生成index.html代码
ls *.html | awk -F"(.html)" '{print $1 }'|awk -F"(_ColorsWorld_2022-)|(.html)" '{print "<li><a href=\"articles/2022/" $0 ".html\">" $1  "</a></li>"}'

ls *.html | awk -F"(.html)" '{print $1 }'|awk -F"ColorsWorld_2022-" '{print "<li><a href=\"articles/2022/" $0 ".html\">" $2  "</a></li>"}'
```

#### 加入贡献
- 可以邮件ggy_778@sina.com加入我们一起备份
