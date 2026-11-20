import { Button, Empty, Popconfirm, Table } from 'antd';
import type { TableProps } from 'antd';

export function DataTable<RecordType extends object>(props: TableProps<RecordType>) {
  return <Table<RecordType>
    {...props}
    pagination={props.pagination ?? false}
    locale={{ ...props.locale, emptyText: props.locale?.emptyText ?? <Empty description="尚无真实记录" /> }}
  />;
}

export function ConfirmAction({
  label, title, onConfirm, disabled = false,
}: { label: string; title: string; onConfirm: () => void; disabled?: boolean }) {
  return <Popconfirm title={title} onConfirm={onConfirm}
    okText="确认" cancelText="取消" disabled={disabled}>
    <Button disabled={disabled}>{label}</Button>
  </Popconfirm>;
}
