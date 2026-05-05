import { IsNumber, Min } from 'class-validator';

export class SubmitBidDto {
  @IsNumber()
  @Min(0)
  bidAmount: number;
}
