/**
 * Lucene query_string 关键字转义
 *
 * 混合检索的全文条件最终会变成 `query_string.query`（DBMS_HYBRID_SEARCH 内部走
 * Lucene 语法），用户输入里的特殊字符会被当语法解释，轻则查不到，重则抛解析错误。
 * 这里对 query_string 保留字符统一用反斜杠转义，让关键字按字面量参与匹配。
 *
 * 覆盖契约列出的字符：+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
 * （`&&` / `||` 是多字符操作符，逐字符转义 `&`、`|` 在 Lucene 中同样合法且更彻底）
 */

/** query_string 特殊字符：+ - & | ! ( ) { } [ ] ^ " ~ * ? : \ / */
const QUERY_STRING_SPECIAL_RE = /[+\-&|!(){}[\]^"~*?:\\/]/g;

/**
 * 转义关键字中的 Lucene query_string 特殊字符。
 * 例：`a+b(c)` → `a\+b\(c\)`
 */
export function escapeQueryStringKeyword(keyword: string): string {
  return keyword.replace(QUERY_STRING_SPECIAL_RE, '\\$&');
}
