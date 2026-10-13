-- 将历史生成的系统目录默认值迁移为服务工作目录下的项目 storage；不移动已有文件。
UPDATE ky_storage_setting
SET local_directory = './storage'
WHERE id='local' AND (local_directory IS NULL OR local_directory='' OR local_directory='/var/lib/kww/storage');
