import { Button, Empty, Popconfirm, Table } from 'antd';
import type { TableProps } from 'antd';

export function DataTable<RecordType extends object>(props: TableProps<RecordType>) {
  return <Table<RecordType>
    {...props}
    pagination={props.pagination ?? false}
    locale={{ ...props.locale, emptyText: props.locale?.emptyText ?? <Empty description="尚无真实记录" /> }}
  />;
}

/** One unbreakable value (a long repository path or project name) must not widen the confirmation off-screen. */
const confirmationText = { maxWidth: 360, whiteSpace: 'pre-line', wordBreak: 'break-all' } as const;

/**
 * `loading` marks the trigger and disables Cancel while `onConfirm` is pending. The promise it returns keeps the
 * confirmation open until it settles, so a confirm cannot be sent twice.
 */
export function ConfirmAction({
  label, title, description, okText = '确认', cancelText = '取消', onConfirm,
  disabled = false, loading = false, danger = false, size = 'middle',
}: {
  label: string; title: string; description?: string; okText?: string; cancelText?: string;
  onConfirm: () => void | Promise<void>; disabled?: boolean; loading?: boolean; danger?: boolean;
  size?: 'small' | 'middle' | 'large';
}) {
  return <Popconfirm title={<div style={confirmationText}>{title}</div>}
    description={description && <div style={confirmationText}>{description}</div>}
    okText={okText} cancelText={cancelText} okButtonProps={{ danger }} cancelButtonProps={{ disabled: loading }}
    disabled={disabled} onConfirm={onConfirm}>
    <Button danger={danger} disabled={disabled} loading={loading} size={size}>{label}</Button>
  </Popconfirm>;
}
