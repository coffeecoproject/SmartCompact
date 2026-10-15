// 两条线：允许压缩线 L（超过它，做完一件事时压缩才划算）、上限 C（原生压缩点）。
// 插件不设自己的兜底线：一直等不到做完一件事，就交给原生在上限处压缩，和没装插件时一样。

export type Lines = {
  allow: number
  ceiling: number
}
