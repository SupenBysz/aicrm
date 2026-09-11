/** 运行时 debug 环境变量不能启用开发信任。标记只由构建器写入。 */
export function permitsDevelopmentUpdates(buildMarked:boolean,packaged:boolean,platform:string):boolean{return buildMarked&&!packaged&&platform==='darwin';}
